import type { AccountData, MetricItem, PositionItem } from '../types';

type Row = Record<string, any>;
const list = (value: any): Row[] => value ? (Array.isArray(value) ? value : [value]) : [];
const numeric = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '' || typeof value === 'boolean') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};
const required = (value: unknown, field: string): number => {
    const n = numeric(value);
    if (n === undefined) throw new Error(`Ve Flex reportu chybí nebo je neplatné pole ${field}. Zapněte všechny sloupce příslušné sekce.`);
    return n;
};

export function accountDate(value: unknown): string {
    const s = String(value ?? '').split(';')[0];
    if (/^\d{8}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replaceAll('-', '');
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s.split('.').reverse().join('');
    return '';
}

const displayDate = (value: string) => `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)}`;
export const accountMetric = (data: AccountData, tag: string): string | number | undefined => {
    const item = data.find(item => item.tag === tag);
    return item && typeof item.value !== 'object' ? item.value : undefined;
};

/** Flex position values and FIFO P/L are in the instrument currency, NAV rows in base. */
export function parseAccountReport(report: Row): AccountData {
    const statements = list(report.FlexStatements?.FlexStatement);
    if (!statements.length) throw new Error('Flex report neobsahuje žádný výpis.');
    const datasets: { data: AccountData; name: string }[] = [];
    const latestStatements = new Map<string, Row>();
    for (const stmt of statements) {
        const id = String(stmt.accountId ?? stmt.AccountInformation?.accountId ?? '');
        if (!id) throw new Error('Ve Flex reportu chybí Account ID.');
        const previous = latestStatements.get(id);
        if (!previous || accountDate(stmt.toDate) > accountDate(previous.toDate)) latestStatements.set(id, stmt);
        else if (accountDate(stmt.toDate) === accountDate(previous.toDate) && JSON.stringify(stmt) !== JSON.stringify(previous)) {
            throw new Error('Report obsahuje více různých výpisů stejného účtu a data. Použijte konsolidovaný výpis bez rozdělení podle modelů.');
        }
    }
    for (const [accountId, stmt] of latestStatements) {
        const info = list(stmt.AccountInformation?.AccountInformation ?? stmt.AccountInformation)[0];
        const currency = String(info?.currency ?? info?.baseCurrency ?? stmt.currency ?? stmt.baseCurrency ?? '');
        if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('V reportu chybí základní měna účtu. Přidejte sekci Account Information / Currency.');
        const equity = list(stmt.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
        if (!equity.length) throw new Error('Chybí Net Asset Value (NAV) Summary in Base. Hodnotu účtu nelze určit.');
        equity.sort((a, b) => accountDate(b.reportDate).localeCompare(accountDate(a.reportDate)));
        const eq = equity[0];
        if (eq.currency && eq.currency !== currency) throw new Error('Základní měna v Account Information neodpovídá souhrnu NAV.');
        const date = accountDate(eq.reportDate);
        if (!date) throw new Error('V souhrnu NAV chybí datum reportu.');
        const sameDate = equity.filter(e => accountDate(e.reportDate) === date);
        if (sameDate.some(e => JSON.stringify(e) !== JSON.stringify(eq))) throw new Error('NAV obsahuje více souhrnů pro stejné datum. Použijte výpis bez rozdělení podle modelů.');
        const total = required(eq.total ?? eq.totalNav, 'NAV / Total');
        const cash = required(eq.cash ?? eq.cashBalance, 'NAV / Cash');
        const data: AccountData = [
            { tag: 'NetLiquidation', value: total, currency },
            { tag: 'CashBalance', value: cash, currency },
            { tag: 'BaseCurrency', value: currency },
            { tag: 'AccountIds', value: JSON.stringify([accountId]) },
            { tag: 'ReportDate', value: displayDate(date) },
        ];
        const rates = list(stmt.ConversionRates?.ConversionRate);
        const latestRate = (from: string, to: string) => rates
            .filter(r => r.fromCurrency === from && r.toCurrency === to && (!accountDate(r.reportDate) || accountDate(r.reportDate) <= date))
            .sort((a, b) => accountDate(b.reportDate).localeCompare(accountDate(a.reportDate)))[0];
        const eurCzk = numeric(latestRate('EUR', 'CZK')?.rate);
        if (eurCzk && eurCzk > 0) data.push({ tag: 'EurToCzkRate', value: eurCzk });

        if (stmt.OpenPositions === undefined) throw new Error('V reportu chybí sekce Open Positions. Bez ní nelze ověřit složení portfolia.');
        const groups = new Map<string, Row[]>();
        for (const pos of list(stmt.OpenPositions?.OpenPosition)) {
            const positionDate = accountDate(pos.reportDate);
            if (positionDate && positionDate !== date) continue;
            const detail = String(pos.levelOfDetail ?? 'SUMMARY').toUpperCase();
            if (detail !== 'SUMMARY' && detail !== 'LOT') continue;
            const key = JSON.stringify([pos.accountId ?? accountId, pos.model ?? '', pos.currency, pos.conid ?? [pos.symbol, pos.assetCategory, pos.expiry, pos.strike, pos.putCall]]);
            groups.set(key, [...(groups.get(key) ?? []), pos]);
        }
        for (const rows of groups.values()) {
            const summaries = rows.filter(p => String(p.levelOfDetail ?? 'SUMMARY').toUpperCase() === 'SUMMARY');
            if (summaries.length > 1 && summaries.some(p => JSON.stringify(p) !== JSON.stringify(summaries[0]))) {
                throw new Error('Open Positions obsahuje nejednoznačné souhrnné řádky pro stejný instrument.');
            }
            const selected = summaries.length ? [summaries[0]] : rows;
            const positions = selected.map(pos => {
                const quantity = required(pos.position ?? pos.quantity, 'Open Positions / Quantity');
                const marketValue = required(pos.positionValue, 'Open Positions / Position Value');
                const native = String(pos.currency ?? '');
                if (!native) throw new Error('U pozice chybí měna instrumentu.');
                const fx = numeric(pos.fxRateToBase) ?? (native === currency ? 1 : numeric(latestRate(native, currency)?.rate));
                if (fx === undefined || fx <= 0) throw new Error(`Chybí platný FX Rate to Base pro ${native}/${currency}.`);
                const assetClass = String(pos.assetCategory ?? '');
                const multiplier = numeric(pos.multiplier) ?? (['STK', 'CRYPTO', 'CASH'].includes(assetClass) ? 1 : undefined);
                if (multiplier === undefined || multiplier <= 0) throw new Error(`Chybí platný Multiplier u ${String(pos.symbol)}.`);
                const strike = numeric(pos.strike);
                if (assetClass === 'OPT' && (strike === undefined || strike < 0 || !['P', 'C'].includes(pos.putCall))) throw new Error('U opce chybí platný Strike nebo Put/Call.');
                const costBasisMoney = numeric(pos.costBasisMoney);
                const pnl = numeric(pos.fifoPnlUnrealized) ?? numeric(pos.unrealizedPnL) ?? (costBasisMoney === undefined ? undefined : marketValue - costBasisMoney);
                return {
                    tag: 'Position' as const, currency: native,
                    value: {
                        accountId, model: String(pos.model ?? ''), conid: pos.conid === undefined ? undefined : String(pos.conid),
                        underlyingConid: pos.underlyingConid ? String(pos.underlyingConid) : undefined,
                        tradingClass: pos.tradingClass || String(pos.symbol ?? '').split(/\s/)[0], symbol: String(pos.symbol ?? ''), underlying: pos.underlyingSymbol || undefined,
                        quantity, marketValue, markPrice: required(pos.markPrice, 'Open Positions / Mark Price'),
                        assetClass, fxRateToBase: fx, multiplier, expiry: accountDate(pos.expiry) ? displayDate(accountDate(pos.expiry)) : undefined,
                        strike, type: pos.putCall === 'P' ? 'PUT' as const : pos.putCall === 'C' ? 'CALL' as const : undefined,
                        costPrice: numeric(pos.costBasisPrice) ?? numeric(pos.costPrice), costBasisPrice: numeric(pos.costBasisPrice),
                        costBasisMoney, fifoPnlUnrealized: pnl, unrealizedPnL: pnl,
                        commitedCapital: assetClass === 'OPT' && quantity < 0 && pos.putCall === 'P' ? strike! * multiplier * Math.abs(quantity) : undefined,
                    },
                };
            });
            const combined: PositionItem = { ...positions[0], value: { ...positions[0].value } };
            if (positions.length > 1) {
                for (const field of ['quantity', 'marketValue', 'costBasisMoney', 'fifoPnlUnrealized', 'unrealizedPnL', 'commitedCapital'] as const) {
                    const values = positions.map(p => p.value[field]);
                    (combined.value as Row)[field] = values.every(v => v !== undefined) ? values.reduce<number>((sum, v) => sum + v!, 0) : undefined;
                }
                const weight = positions.reduce((sum, p) => sum + Math.abs(p.value.quantity), 0);
                combined.value.costPrice = positions.every(p => p.value.costPrice !== undefined) && weight > 0
                    ? positions.reduce((sum, p) => sum + p.value.costPrice! * Math.abs(p.value.quantity), 0) / weight : undefined;
                combined.value.costBasisPrice = combined.value.costPrice;
            }
            if (combined.value.quantity !== 0) data.push(combined);
        }
        for (const [field, assetClass] of [['stock', 'STK'], ['options', 'OPT'], ['crypto', 'CRYPTO']]) {
            const expected = numeric(eq[field]);
            if (expected === undefined) continue;
            const items = data.filter((p): p is PositionItem => p.tag === 'Position' && typeof p.value === 'object' && p.value.assetClass === assetClass);
            const sum = items.reduce((sum, p) => sum + p.value.marketValue * p.value.fxRateToBase!, 0);
            if (Math.abs(sum - expected) > Math.max(0.02, items.length * 0.01)) throw new Error(`Hodnota pozic ${assetClass} nesouhlasí s NAV. Ověřte datum reportu a zahrnutí všech pozic.`);
        }
        datasets.push({ data, name: info?.acctAlias || info?.accountAlias || accountId });
    }
    return mergeAccountDatas(datasets);
}

/** Combining different base currencies or overlapping accounts would silently corrupt totals. */
export function mergeAccountDatas(datasets: { data: AccountData; name: string }[]): AccountData {
    if (!datasets.length) return [];
    const currencies = new Set(datasets.map(({ data }) => accountMetric(data, 'BaseCurrency')));
    if (currencies.size !== 1 || currencies.has(undefined)) throw new Error('Účty mají různé základní měny. Přehled zobrazte pro jednotlivé účty; jejich částky nelze přímo sčítat.');
    const currency = String([...currencies][0]);
    const ids = new Set<string>();
    const dates = new Set<string>();
    let netLiq = 0, cash = 0;
    const positions: PositionItem[] = [];
    for (const { data, name } of datasets) {
        const accountIds: string[] = JSON.parse(String(accountMetric(data, 'AccountIds') ?? '[]'));
        for (const id of accountIds) {
            if (ids.has(id)) throw new Error('Stejný IBKR účet je obsažen ve více dotazech. Odeberte překrývající se dotaz, jinak by se majetek započítal dvakrát.');
            ids.add(id);
        }
        netLiq += required(accountMetric(data, 'NetLiquidation'), 'NAV');
        cash += required(accountMetric(data, 'CashBalance'), 'Cash');
        for (const dateText of String(accountMetric(data, 'ReportDate') ?? '').split(' / ')) {
            const date = accountDate(dateText);
            if (date) dates.add(date);
        }
        for (const p of data) if (p.tag === 'Position' && typeof p.value === 'object') {
            positions.push({ ...p, tag: 'Position', currency: p.currency!, value: { ...p.value, accountName: name } });
        }
    }
    const sortedDates = [...dates].sort();
    const metrics: MetricItem[] = [
        { tag: 'NetLiquidation', value: netLiq, currency }, { tag: 'CashBalance', value: cash, currency },
        { tag: 'BaseCurrency', value: currency }, { tag: 'AccountIds', value: JSON.stringify([...ids]) },
    ];
    if (sortedDates.length) metrics.push({ tag: 'ReportDate', value: sortedDates.map(displayDate).join(' / ') });
    if (sortedDates.length > 1) metrics.push({ tag: 'DataWarning', value: 'Účty mají různá data výpisu. Součet není oceněním k jedinému dni.' });
    const rate = accountMetric(datasets[0].data, 'EurToCzkRate');
    if (rate !== undefined) metrics.push({ tag: 'EurToCzkRate', value: rate });
    return [...metrics, ...positions];
}

/** Theoretical put exercise cash exposure, excluding premium; not broker margin or available funds. */
export function annotatePutCommitments(input: PositionItem[]): PositionItem[] {
    const result = input.map(p => ({ ...p, value: { ...p.value } }));
    const key = (p: PositionItem) => JSON.stringify([
        // Never offset contracts held in separate accounts, models, currencies or expirations.
        p.value.accountId ?? p.value.accountName ?? 'unknown', p.value.model ?? '', p.currency,
        p.value.underlyingConid ?? p.value.underlying ?? p.value.symbol,
        accountDate(p.value.expiry) || p.value.symbol, p.value.multiplier, p.value.tradingClass ?? '',
    ]);
    const longs = new Map<string, { strike: number; quantity: number }[]>();
    for (const p of result) if (p.value.assetClass === 'OPT' && p.value.type === 'PUT' && p.value.quantity > 0) {
        const pool = longs.get(key(p)) ?? [];
        pool.push({ strike: p.value.strike!, quantity: p.value.quantity });
        pool.sort((a, b) => b.strike - a.strike);
        longs.set(key(p), pool);
    }
    const shorts = result.filter(p => p.value.assetClass === 'OPT' && p.value.type === 'PUT' && p.value.quantity < 0)
        .sort((a, b) => (b.value.strike ?? 0) - (a.value.strike ?? 0));
    for (const p of shorts) {
        const mult = p.value.multiplier!;
        const strike = p.value.strike!;
        let remaining = Math.abs(p.value.quantity), amount = 0;
        for (const hedge of longs.get(key(p)) ?? []) {
            const quantity = Math.min(remaining, hedge.quantity);
            amount += Math.max(0, strike - hedge.strike) * mult * quantity;
            remaining -= quantity;
            hedge.quantity -= quantity;
            if (!remaining) break;
        }
        p.value.commitedCapital = strike * mult * Math.abs(p.value.quantity);
        p.value.netCommitedCapital = amount + strike * mult * remaining;
        p.value.hedgedQty = Math.abs(p.value.quantity) - remaining;
    }
    return result;
}
