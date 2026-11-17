// Stažení a extrakce dat pro srovnání s benchmarkem.
//
// Záměrně nesdílí kód s /api/account — ta routa zůstává nedotčená. Statement má
// při 365denním období ~6 MB, takže se tady navíc cachuje: v paměti i na disk do
// data/ (dev server se překládá často a paměťová cache by se ztrácela).

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isValidYmd, mergeNavSeries, type NavPoint, type FlowPoint } from './twr';
import { TRADES_WITHOUT_EXECUTION_WARNING, type TaxInputs, type RealizedTrade } from './tax';
import { mergeCashBalances, sumByDate, type CashBalance } from './cash';

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const PICKUP_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';

// Stejné jako v /api/account — přechodné chyby IBKR, u kterých má smysl retry.
const RETRYABLE_CODES = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021]);

// Vklady a výběry ve Statement of Funds. Ostatní kódy (BUY, SELL, DIV, FRTAX…)
// jsou vnitřní pohyby portfolia a do cash flow očištění nepatří.
const EXTERNAL_FLOW_CODES = new Set(['DEP', 'WITH']);

// Sekce OptionEAE (uplatnění, přiřazení, expirace opcí) je celá obsažená
// v Trades — u tohoto účtu se shoduje všech 50 tradeID i realizované P/L do
// koruny. Daňové vstupy proto berou výhradně Trades, jinak by expirované opce
// vstoupily do základu dvakrát.
const TAX_TRADE_LEVEL = 'EXECUTION';

const CACHE_SCHEMA_VERSION = 5;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_DIR = path.join(process.cwd(), 'data');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
});

export interface PerformanceSeries {
    accountIds: string[];
    currency: string;                    // bázová měna účtu
    fromDate: string;
    toDate: string;
    nav: NavPoint[];                     // denní NAV, vzestupně
    flows: FlowPoint[];                  // vklady/výběry
    fxToUsd: Record<string, number>;     // YYYYMMDD → kolik bázové měny za 1 USD
    tax: TaxInputs;                      // podklady pro odhad daně
    /** Hotovost podle měn k poslednímu dni (sekce FxPositions); chybí, když sekce není zapnutá. */
    cashByCurrency?: CashBalance[];
    /** NAV bez hotovosti a naběhlých úroků/dividend po dnech; chybí, když NAV nemá sloupec cash. */
    nonCashByDate?: Record<string, number>;
    fetchedAt: number;
    schemaVersion: number;
    warnings: string[];
}

const memCache = new Map<string, { at: number; data: PerformanceSeries }>();
const inFlight = new Map<string, Promise<PerformanceSeries>>();

const cacheKey = (token: string, queryId: string) =>
    crypto.createHash('sha256').update(`${token}:${queryId}`).digest('hex').slice(0, 16);

function readDiskCache(key: string): PerformanceSeries | null {
    try {
        const file = path.join(CACHE_DIR, `perf-${key}.json`);
        const raw = fs.readFileSync(file, 'utf-8');
        const data: PerformanceSeries = JSON.parse(raw);
        if (data.schemaVersion !== CACHE_SCHEMA_VERSION || !Number.isFinite(data.fetchedAt)
            || data.fetchedAt > Date.now() || Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
        return data;
    } catch {
        return null;
    }
}

function writeDiskCache(key: string, data: PerformanceSeries) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(path.join(CACHE_DIR, `perf-${key}.json`), JSON.stringify(data));
    } catch (e) {
        console.warn('Nepodařilo se zapsat cache výkonnosti:', e);
    }
}

const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
    v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export async function getPerformanceSeries(
    token: string,
    queryId: string,
    opts: { force?: boolean } = {},
): Promise<PerformanceSeries> {
    const key = cacheKey(token, queryId);

    if (!opts.force) {
        const mem = memCache.get(key);
        if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data;

        const disk = readDiskCache(key);
        if (disk) {
            memCache.set(key, { at: disk.fetchedAt, data: disk });
            return disk;
        }
    }

    // Souběžné požadavky sdílí jedno stažení — jinak by se při přepnutí záložky
    // vystřelily dva flex requesty naráz a IBKR vrátí 1018 (rate limit).
    const running = inFlight.get(key);
    if (running) return running;

    const p = (async () => {
        const statements = await fetchFlexStatements(token, queryId);
        const data = extractSeries(statements);
        memCache.set(key, { at: data.fetchedAt, data });
        writeDiskCache(key, data);
        return data;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    return p;
}

async function fetchFlexStatements(token: string, queryId: string): Promise<any[]> {
    const headers = { 'User-Agent': 'Java/1.8.0_202' };

    // 1) Vyžádání reportu
    let referenceCode: string | number | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await axios.get(SEND_URL, { params: { t: token, q: queryId, v: '3' }, headers, timeout: 30000 });
        const root = parser.parse(res.data).FlexStatementResponse ?? parser.parse(res.data);

        if (root.Status !== 'Fail') {
            referenceCode = root.ReferenceCode;
            break;
        }
        const code = Number(root.ErrorCode);
        console.error(`Flex request selhal (pokus ${attempt}/3): ${code} ${root.ErrorMessage}`);
        if (!RETRYABLE_CODES.has(code) || attempt === 3) {
            throw new Error(String(root.ErrorMessage ?? 'Flex request selhal'));
        }
        await new Promise(r => setTimeout(r, 30000));
    }

    if (!referenceCode) throw new Error('IBKR nevrátilo reference code.');

    // 2) Vyzvednutí (report se generuje asynchronně)
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res = await axios.get(PICKUP_URL, {
                params: { t: token, q: referenceCode, v: '3' },
                headers,
                timeout: 30000,
            });
            const parsed = parser.parse(res.data);
            const report = parsed.FlexQueryResponse;
            if (report) {
                const list = asArray<any>(report.FlexStatements?.FlexStatement);
                if (list.length === 0) throw new Error('Report neobsahuje žádný FlexStatement.');
                return list;
            }
            const root = parsed.FlexStatementResponse;
            if (root?.Status === 'Fail' && !RETRYABLE_CODES.has(Number(root.ErrorCode))) {
                throw new Error(`FlexStatement: ${String(root.ErrorMessage)}`);
            }
        } catch (err) {
            if (err instanceof Error && err.message.includes('FlexStatement')) throw err;
            console.error('Chyba při vyzvedávání reportu:', err instanceof Error ? err.message : 'Neznámá chyba');
        }
    }

    throw new Error('Report se nepodařilo vyzvednout (timeout).');
}

/**
 * Vytáhne ze statementu tři řady, které TWR potřebuje. Víc účtů v jednom query
 * se sečte po dnech — TWR se pak počítá nad jejich součtem, což je správně
 * (portfolio jako celek), na rozdíl od průměrování výnosů jednotlivých účtů.
 */
function flexDate(value: unknown, context: string): string {
    const date = String(value ?? '').split(';')[0].replaceAll('-', '');
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    if (!isValidYmd(date) || date > today) throw new Error(`Neplatné nebo budoucí datum v ${context}.`);
    return date;
}

function requiredNumber(value: unknown, context: string): number {
    if (value === undefined || value === null || String(value).trim() === '' || !Number.isFinite(Number(value))) {
        throw new Error(`Chybí platná částka v ${context}.`);
    }
    return Number(value);
}

export function extractSeries(statements: any[]): PerformanceSeries {
    if (!statements.length) throw new Error('Report neobsahuje účty.');
    const accounts = new Map<string, any[]>();
    const warnings = new Set<string>();
    for (const stmt of statements) {
        const accountId = String(stmt.accountId ?? '');
        if (!accountId) throw new Error('Report neobsahuje identifikátor účtu.');
        accounts.set(accountId, [...(accounts.get(accountId) ?? []), stmt]);
    }
    const extracted: PerformanceSeries[] = [];
    for (const [accountId, accountStatements] of accounts) {
        const navByDate = new Map<string, number>();
        const flowByDate = new Map<string, number>();
        const fxToUsd: Record<string, number> = {};
        const tax: TaxInputs = { trades: [], unrealized: [], dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] };
        const currencies = new Set<string>();
        const seenRows = new Map<string, string>();
        const trades: any[] = [];
        let latestPositionDate = '';
        let positions: any[] = [];
        let fxPositions: any[] | undefined;
        const nonCashByDate: Record<string, number> = {};
        let nonCashComplete = true;

        // Repeated query periods must not duplicate an account's transactions.
        // Keep identical, ID-less rows within one statement: two equal deposits
        // can be real. Across overlapping statements preserve their multiplicity.
        const occurrenceCounts = new Map<string, number>();
        function uniqueRows(stmt: any, section: string, item: string, accept?: (row: any) => boolean): any[] {
            const inStatement = new Map<string, number>();
            return asArray<any>(stmt[section]?.[item]).filter(row => {
                if (accept && !accept(row)) return false;
                const id = row.transactionID || row.tradeID;
                const serialized = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
                if (id) {
                    const key = `${section}:${id}:${row.levelOfDetail ?? ''}`;
                    const prior = seenRows.get(key);
                    if (prior && prior !== serialized) throw new Error('Překrývající se výpisy obsahují rozdílné údaje stejné transakce.');
                    if (prior) return false;
                    seenRows.set(key, serialized);
                    return true;
                }
                const key = `${section}:${serialized}`;
                const occurrence = (inStatement.get(key) ?? 0) + 1;
                inStatement.set(key, occurrence);
                const prior = occurrenceCounts.get(key) ?? 0;
                if (occurrence <= prior) return false;
                occurrenceCounts.set(key, occurrence);
                return true;
            });
        }

        for (const stmt of accountStatements) {
            if (stmt.fromDate) flexDate(stmt.fromDate, 'počátku výpisu');
            if (stmt.toDate) flexDate(stmt.toDate, 'konci výpisu');
            for (const value of [stmt.currency, stmt.AccountInformation?.currency]) {
                if (value && value !== 'BASE_SUMMARY') currencies.add(String(value));
            }
            const rows = asArray<any>(stmt.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
            const consolidatedDates = new Set(rows.filter(row => !row.model).map(row => String(row.reportDate)));
            for (const row of rows) {
                if (row.model) {
                    if (consolidatedDates.has(String(row.reportDate))) continue;
                    throw new Error('NAV obsahuje jen modelové podúčty. Zapni souhrn NAV za celý účet.');
                }
                if (row.accountId && String(row.accountId) !== accountId) throw new Error('Nesouhlasí identifikátor účtu v NAV.');
                const date = flexDate(row.reportDate, 'NAV');
                const total = requiredNumber(row.total, 'NAV');
                if (row.currency && row.currency !== 'BASE_SUMMARY') currencies.add(String(row.currency));
                const prior = navByDate.get(date);
                if (prior !== undefined && Math.abs(prior - total) > 1e-8) throw new Error(`Výpisy obsahují rozdílné NAV k ${date}.`);
                navByDate.set(date, total);
                const cash = row.cash;
                if (cash === undefined || cash === null || String(cash).trim() === '' || !Number.isFinite(Number(cash))) nonCashComplete = false;
                else nonCashByDate[date] = total - Number(cash) - (Number(row.interestAccruals) || 0) - (Number(row.dividendAccruals) || 0);
            }
            if (stmt.StmtFunds === undefined) throw new Error('Ve Flex query chybí Statement of Funds; bez vkladů a výběrů nelze výnos ověřit.');
            const funds = uniqueRows(stmt, 'StmtFunds', 'StatementOfFundsLine');
            const cashRows = funds.filter(row => String(row.levelOfDetail) === 'BaseCurrency');
            if (funds.length && !cashRows.length) throw new Error('Statement of Funds neobsahuje úroveň BaseCurrency.');
            for (const row of cashRows) {
                const code = String(row.activityCode);
                // Opening/closing balances are not dated transactions.
                if (!EXTERNAL_FLOW_CODES.has(code) && !['DIV', 'PIL', 'CINT', 'DINT', 'INTR', 'INTP', 'FRTAX', 'REC', 'DEL'].includes(code)) continue;
                const date = flexDate(row.date, 'Statement of Funds');
                const amount = requiredNumber(row.amount, 'Statement of Funds');
                if (EXTERNAL_FLOW_CODES.has(code)) {
                    // reportDate is the NAV accounting date; date/settleDate can
                    // precede it (confirmed on the broker's delayed deposits).
                    const booked = row.reportDate ? flexDate(row.reportDate, 'zaúčtování vkladu/výběru') : date;
                    flowByDate.set(booked, (flowByDate.get(booked) ?? 0) + amount);
                }
                else if (code === 'DIV' || code === 'PIL') tax.dividends.push({ date, amount });
                else if (['CINT', 'DINT', 'INTR', 'INTP'].includes(code)) tax.interest.push({ date, amount, kind: ['DINT', 'INTP'].includes(code) ? 'expense' : 'income' });
                else if (code === 'FRTAX') {
                    (row.symbol ? tax.dividendWithheld : tax.interestWithheld).push({ date, amount });
                } else if (stmt.Transfers === undefined) {
                    throw new Error('Výpis obsahuje převod cenných papírů. Zapni sekci Transfers včetně Position Amount in Base.');
                }
            }
            if (stmt.Transfers === undefined) warnings.add('Flex query neobsahuje sekci Transfers. Výnos předpokládá, že neproběhly převody cenných papírů mezi brokery.');
            for (const row of uniqueRows(stmt, 'Transfers', 'Transfer')) {
                if (String(row.assetCategory) === 'CASH') continue; // already in DEP/WITH
                const date = flexDate(row.date ?? row.reportDate, 'převodu cenných papírů');
                const amount = requiredNumber(row.positionAmountInBase, 'hodnotě převodu cenných papírů');
                const direction = String(row.direction).toUpperCase();
                if (!['IN', 'OUT'].includes(direction)) throw new Error('Převod cenných papírů nemá platný směr IN/OUT.');
                const value = direction === 'IN' ? Math.abs(amount) : -Math.abs(amount);
                flowByDate.set(date, (flowByDate.get(date) ?? 0) + value);
            }
            if (stmt.Trades === undefined) warnings.add('Chybí sekce Trades; odhad daně nezahrnuje realizované obchody.');
            const tradeRows = Object.values<any>(stmt.Trades && typeof stmt.Trades === 'object' ? stmt.Trades : {})
                .flatMap(value => asArray<any>(value)).filter(row => row && typeof row === 'object');
            if (tradeRows.length && !tradeRows.some(row => String(row.levelOfDetail).toUpperCase() === TAX_TRADE_LEVEL)) {
                warnings.add(TRADES_WITHOUT_EXECUTION_WARNING);
            }
            if (stmt.OpenPositions === undefined) warnings.add('Chybí sekce Open Positions; nelze modelovat daň při likvidaci.');
            // Order summaries and closed lots describe the same executions.
            // Multiple closed lots can share a trade ID, so do not even run
            // execution deduplication on these unused levels.
            trades.push(...uniqueRows(stmt, 'Trades', 'Trade',
                row => String(row.levelOfDetail).toUpperCase() === TAX_TRADE_LEVEL));
            const snapshotDate = stmt.toDate ? flexDate(stmt.toDate, 'pozicích') : '';
            if (snapshotDate >= latestPositionDate) {
                latestPositionDate = snapshotDate;
                positions = asArray<any>(stmt.OpenPositions?.OpenPosition);
                fxPositions = stmt.FxPositions === undefined ? undefined : asArray<any>(stmt.FxPositions?.FxPosition);
            }
            for (const row of asArray<any>(stmt.ConversionRates?.ConversionRate)) {
                if (String(row.fromCurrency) !== 'USD') continue;
                // Currency is validated after all NAV rows have been inspected.
                const target = String(row.toCurrency ?? '');
                if (currencies.size === 1 && !currencies.has(target)) continue;
                const date = flexDate(row.reportDate, 'směnných kurzech');
                const rate = requiredNumber(row.rate, 'směnných kurzech');
                if (rate <= 0) throw new Error('Směnný kurz musí být kladný.');
                if (fxToUsd[date] !== undefined && Math.abs(fxToUsd[date] - rate) > 1e-6 * rate) throw new Error(`Rozdílné směnné kurzy k ${date}.`);
                fxToUsd[date] = rate;
            }
        }
        if (currencies.size !== 1) throw new Error('Bázová měna účtu chybí nebo se v období změnila. Takové částky nelze přímo sčítat.');
        const currency = [...currencies][0];
        const nav: NavPoint[] = [...navByDate].map(([date, nav]) => ({ date, nav })).sort((a, b) => a.date.localeCompare(b.date));
        if (!nav.length) throw new Error('Flex query neobsahuje denní NAV.');
        if (currency === 'USD') for (const row of nav) fxToUsd[row.date] = 1;
        fillFxGaps(fxToUsd, nav.map(n => n.date));
        if (nav.some(n => !fxToUsd[n.date])) warnings.add('Chybí některé kurzy USD. Přepočet do USD a srovnání s americkým benchmarkem nejsou pro celé období dostupné.');
        tax.trades = extractRealizedTrades({ AccountInformation: { currency }, Trades: { Trade: trades } });
        tax.unrealized = extractUnrealizedPositions(positions, currency, latestPositionDate);
        extracted.push({
            accountIds: [accountId], currency, fromDate: nav[0].date, toDate: nav[nav.length - 1].date,
            nav, flows: [...flowByDate].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
            fxToUsd, tax, ...(fxPositions ? { cashByCurrency: extractCashBalances(fxPositions, currency) } : {}),
            ...(nonCashComplete ? { nonCashByDate } : {}),
            fetchedAt: Date.now(), schemaVersion: CACHE_SCHEMA_VERSION, warnings: [],
        });
    }
    const combined = extracted.length === 1 ? null : mergeNavSeries(extracted);
    const merged = !combined ? extracted[0] : {
        ...extracted[0], ...combined,
        cashByCurrency: mergeCashBalances(extracted.map(s => s.cashByCurrency)),
        nonCashByDate: sumByDate(extracted.map(s => s.nonCashByDate), combined.nav.map(n => n.date)), tax: {
            trades: extracted.flatMap(s => s.tax.trades), unrealized: extracted.flatMap(s => s.tax.unrealized),
            dividends: extracted.flatMap(s => s.tax.dividends), dividendWithheld: extracted.flatMap(s => s.tax.dividendWithheld),
            interest: extracted.flatMap(s => s.tax.interest), interestWithheld: extracted.flatMap(s => s.tax.interestWithheld),
        },
    };
    // Open-position snapshots must retain their original date so a liquidation
    // comparison can reject a valuation that differs from the common NAV date.
    for (const key of ['trades', 'dividends', 'dividendWithheld', 'interest', 'interestWithheld'] as const) {
        // The tax horizon cannot run past the latest shared NAV observation.
        (merged.tax[key] as { date: string }[]) = merged.tax[key].filter(item => item.date <= merged.toDate);
    }
    return { ...merged, warnings: [...warnings] };
}

/**
 * P/L bereme jednou z EXECUTION. Hrubé příjmy zahrnují i otevírací prodeje
 * (například vypsané opce); nákup zavírající short není další příjem.
 *
 * Doba držení musí pocházet z brokerova data nabytí. FIFO rekonstrukce pouze
 * uvnitř okna reportu nemůže vyloučit starší počáteční loty a vážený průměr
 * stáří nedokáže rozhodnout o osvobození jednotlivých lotů. Když datum chybí,
 * necháme je neznámé. Brokerovo P/L zůstává orientačním daňovým podkladem.
 */
export function extractRealizedTrades(stmt: any): RealizedTrade[] {
    const baseCurrency = String(stmt.AccountInformation?.currency ?? stmt.currency ??
        asArray<any>(stmt.EquitySummaryInBase?.EquitySummaryByReportDateInBase)[0]?.currency ?? '');
    const compactDate = (value: unknown) => String(value ?? '').replace(/-/g, '').slice(0, 8);
    const out: RealizedTrade[] = [];
    for (const row of asArray<any>(stmt.Trades?.Trade)) {
        if (String(row.levelOfDetail).toUpperCase() !== TAX_TRADE_LEVEL) continue;
        const date = compactDate(row.tradeDate ?? row.dateTime);
        if (!Number.isFinite(daysBetween(date, date))) throw new Error('Obchod nemá platné datum.');
        const rawFx = row.fxRateToBase;
        const fx = baseCurrency && String(row.currency) === baseCurrency ? 1
            : rawFx !== undefined && rawFx !== '' ? Number(rawFx) : NaN;
        if (!Number.isFinite(fx) || fx <= 0) throw new Error('U obchodu chybí kurz do bázové měny.');
        const isClose = String(row.openCloseIndicator ?? '').toUpperCase().includes('C');
        const rawPnl = row.fifoPnlRealized;
        if (isClose && (rawPnl === undefined || rawPnl === '')) throw new Error('Uzavírací obchod nemá realizované P/L.');
        const pnl = Number(rawPnl ?? 0) * fx;
        const rawProceeds = row.proceeds;
        if (rawProceeds === undefined || rawProceeds === '') throw new Error('U obchodu chybí hrubý příjem / výdaj.');
        const proceeds = Number(rawProceeds) * fx;
        const quantity = Number(row.quantity);
        if (![pnl, proceeds, quantity].every(Number.isFinite)) throw new Error('Obchod obsahuje neplatnou číselnou hodnotu.');
        if (!isClose && pnl === 0 && proceeds <= 0) continue;
        const acquired = compactDate(row.openDateTime);
        const holding = daysBetween(acquired, date);
        // Short nikdy nedostane časové osvobození jen podle doby mezi prodejem a nákupem.
        const short = (isClose && quantity > 0) || (!isClose && proceeds > 0);
        out.push({ date, assetCategory: String(row.assetCategory ?? ''), pnl,
            proceeds: Math.max(0, proceeds),
            holdingDays: !short && Number.isFinite(holding) && holding >= 0 ? holding : null,
            ...(!short && Number.isFinite(holding) && holding >= 0 ? { acquiredDate: acquired } : {}),
            ...(short ? { exemptionEligible: false } : {}),
        });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Lots carry acquisition dates; SUMMARY does not establish the age of each
 * holding. Use a complete, reconciled lot breakdown instead of its summary,
 * never both. An incomplete breakdown must not silently lower liquidation tax.
 * https://www.ibkrguides.com/reportingreference/reportguide/open%20positionsfq.htm
 */
export function extractUnrealizedPositions(positions: any[], currency: string, snapshotDate: string): RealizedTrade[] {
    const groups = new Map<string, { summary: any[]; lots: any[] }>();
    for (const row of positions) {
        const level = String(row.levelOfDetail).toUpperCase();
        if (level !== 'SUMMARY' && level !== 'LOT') continue;
        const instrument = row.conid || (row.symbol && JSON.stringify([row.symbol,
            row.expiry ?? '', Number(row.strike) || '', row.putCall ?? '']));
        if (!instrument) throw new Error('Otevřená pozice nemá identifikátor instrumentu.');
        const side = Number(row.position ?? row.quantity) < 0 ? 'SHORT' : 'LONG';
        const key = JSON.stringify([row.accountId ?? '', row.model ?? '', row.currency ?? '',
            row.assetCategory ?? '', instrument, side]);
        const group = groups.get(key) ?? { summary: [], lots: [] };
        group[level === 'LOT' ? 'lots' : 'summary'].push(row);
        groups.set(key, group);
    }
    const amounts = (row: any) => {
        const rate = row.currency === currency ? 1 : requiredNumber(row.fxRateToBase, 'kurzu otevřené pozice');
        if (rate <= 0) throw new Error('Neplatný kurz otevřené pozice.');
        return {
            quantity: requiredNumber(row.position ?? row.quantity, 'množství otevřené pozice'),
            pnl: requiredNumber(row.fifoPnlUnrealized, 'nerealizovaném zisku') * rate,
            value: requiredNumber(row.positionValue, 'hodnotě otevřené pozice') * rate,
        };
    };
    const out: RealizedTrade[] = [];
    for (const group of groups.values()) {
        if (group.summary.length > 1) throw new Error('Otevřené pozice obsahují více souhrnů stejného instrumentu.');
        if (group.summary.length && group.lots.length) {
            const total = amounts(group.summary[0]);
            const sum = group.lots.map(amounts).reduce((s, row) => ({
                quantity: s.quantity + row.quantity, pnl: s.pnl + row.pnl, value: s.value + row.value,
            }), { quantity: 0, pnl: 0, value: 0 });
            const tolerance = 0.01 * Math.max(1, group.lots.length);
            if (Math.abs(sum.quantity - total.quantity) > 1e-8 || Math.abs(sum.pnl - total.pnl) > tolerance ||
                Math.abs(sum.value - total.value) > tolerance) {
                throw new Error('Loty otevřené pozice nesouhlasí se souhrnem; nelze ověřit daň při likvidaci.');
            }
        }
        for (const row of group.lots.length ? group.lots : group.summary) {
            const { quantity, pnl, value } = amounts(row);
            if (quantity === 0 && pnl === 0 && value === 0) continue;
            const date = flexDate(row.reportDate || snapshotDate, 'otevřené pozici');
            const acquired = String(row.openDateTime ?? '').replaceAll('-', '').slice(0, 8);
            const holding = daysBetween(acquired, date);
            const short = quantity < 0 || value < 0 || String(row.side).toUpperCase() === 'SHORT';
            const knownHolding = !short && String(row.levelOfDetail).toUpperCase() === 'LOT' &&
                Number.isFinite(holding) && holding >= 0;
            out.push({ date, assetCategory: String(row.assetCategory ?? ''), pnl, proceeds: Math.max(0, value),
                holdingDays: knownHolding ? holding : null,
                ...(knownHolding ? { acquiredDate: acquired } : {}),
                ...(short ? { exemptionEligible: false } : {}),
            });
        }
    }
    return out;
}

/** Cash balances per currency from FxPositions SUMMARY rows; values are in base currency. */
export function extractCashBalances(rows: any[], baseCurrency: string): CashBalance[] {
    const summary = rows.filter(row => String(row.levelOfDetail ?? 'SUMMARY').toUpperCase() === 'SUMMARY');
    const list = summary.map(row => {
        if (row.functionalCurrency && String(row.functionalCurrency) !== baseCurrency) {
            throw new Error('Hotovost ve FxPositions není oceněna v bázové měně účtu.');
        }
        return {
            currency: String(row.fxCurrency ?? ''),
            quantity: requiredNumber(row.quantity, 'hotovosti podle měn'),
            value: requiredNumber(row.value, 'hodnotě hotovosti podle měn'),
        };
    }).filter(row => row.currency && (Math.abs(row.value) >= 1 || Math.abs(row.quantity) >= 1));
    return mergeCashBalances([list])!;
}

function daysBetween(from: string, to: string): number {
    const parse = (value: string) => {
        if (!/^\d{8}$/.test(value)) return NaN;
        const date = new Date(Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8)));
        return date.toISOString().slice(0, 10).replace(/-/g, '') === value ? date.getTime() : NaN;
    };
    return (parse(to) - parse(from)) / 86400000;
}

function fillFxGaps(fx: Record<string, number>, dates: string[]) {
    // Include rates on dates without NAV, and never borrow from the future.
    const rateDates = Object.keys(fx).sort();
    let i = 0;
    let last: number | undefined;
    for (const date of dates) {
        while (i < rateDates.length && rateDates[i] <= date) last = fx[rateDates[i++]];
        if (!fx[date] && last !== undefined) fx[date] = last;
    }
}
