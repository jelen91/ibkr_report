import type { Account } from '../types';
import type { NavPoint, FlowPoint } from './twr';

export interface Quote {
    symbol: string;
    name: string;
    currency: string;
    price: number;
    history: Record<string, number>;
    asOf?: number;
}
export interface QuotesPayload {
    quotes: Record<string, Quote>;
    fx: Record<string, Quote>;
    btc: Quote | null;
    failed: string[];
}
export interface HoldingRow { id: string; symbol: string; quantity: number; note: string }
export interface ManualRow { id: string; name: string; amount: number; currency: string }
export interface OverviewSeries {
    currency: string;
    accountIds: string[];
    nav: NavPoint[];
    flows: FlowPoint[];
}

/** Carry only observations available by this date; never backfill from the future. */
export function valueAt(history: Record<string, number>, date: string): number | null {
    const key = Object.keys(history).filter(d => d <= date && Number.isFinite(history[d])).sort().pop();
    return key === undefined ? null : history[key];
}

export function czkRate(quotes: QuotesPayload | null, currency: string, date?: string): number | null {
    if (currency === 'CZK') return 1;
    const quote = quotes?.fx[currency];
    if (!quote) return null;
    const value = date ? valueAt(quote.history, date) : quote.price;
    return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function pricedValue(quantity: number, price: number | null, rate: number | null): number | null {
    if (!Number.isFinite(quantity)) return null;
    if (quantity === 0) return 0;
    return price !== null && rate !== null && Number.isFinite(price) && price > 0
        ? quantity * price * rate : null;
}
const sumKnown = (values: (number | null)[]): number | null =>
    values.some(v => v === null) ? null : (values as number[]).reduce((s, v) => s + v, 0);

export function buildOverview(input: {
    accounts: Account[];
    series: Record<string, OverviewSeries>;
    holdings: HoldingRow[];
    manual: ManualRow[];
    btcAmount: number;
    quotes: QuotesPayload | null;
    today: string;
}) {
    const { accounts, series, holdings, manual, btcAmount, quotes, today } = input;
    const seen = new Set<string>();
    const ibkrRows = accounts.map(account => {
        const data = series[account.id];
        const overlap = data?.accountIds.some(id => seen.has(id)) ?? false;
        data?.accountIds.forEach(id => seen.add(id));
        const last = data?.nav.filter(p => p.date <= today).at(-1);
        const rate = data && last ? czkRate(quotes, data.currency, last.date) : null;
        const value = !overlap && last && Number.isFinite(last.nav) && rate !== null ? last.nav * rate : null;
        return { account, value, date: last?.date ?? null, loaded: value !== null, overlap };
    });
    const ibkrTotal = sumKnown(ibkrRows.map(row => row.value));
    const btcQuote = quotes?.btc ?? null;
    const btcValue = pricedValue(btcAmount, btcQuote?.price ?? null, btcQuote ? czkRate(quotes, btcQuote.currency) : null);
    const holdingValues = holdings.map(row => {
        const quote = quotes?.quotes[row.symbol.trim().toUpperCase()] ?? null;
        return { row, quote, value: pricedValue(row.quantity, quote?.price ?? null, quote ? czkRate(quotes, quote.currency) : null) };
    });
    const manualValues = manual.map(row => {
        const rate = czkRate(quotes, row.currency);
        return { row, value: row.amount === 0 ? 0 : rate !== null && Number.isFinite(row.amount) ? row.amount * rate : null };
    });
    const parts: { key: string; label: string; value: number | null; detail: string }[] = [];
    if (accounts.length) parts.push({ key: 'ibkr', label: 'IBKR', value: ibkrTotal, detail: accounts.map(a => a.name).join(', ') });
    if (btcAmount !== 0) parts.push({ key: 'btc', label: 'Bitcoin', value: btcValue, detail: `${btcAmount} BTC` });
    for (const { row, value } of holdingValues) {
        if (row.quantity !== 0) parts.push({ key: `h:${row.id}`, label: row.note || row.symbol, value, detail: `${row.quantity} ks ${row.symbol}` });
    }
    for (const { row, value } of manualValues) {
        if (row.amount !== 0) parts.push({ key: `m:${row.id}`, label: row.name || 'Ruční položka', value, detail: `${row.amount} ${row.currency}` });
    }
    const total = sumKnown(parts.map(p => p.value));
    const knownTotal = parts.reduce((s, p) => s + (p.value ?? 0), 0);
    const missing = parts.filter(p => p.value === null).map(p => p.label);
    const dateSet = new Set<string>();
    Object.values(series).forEach(s => s.nav.forEach(p => dateSet.add(p.date)));
    if (btcAmount !== 0 && btcQuote) Object.keys(btcQuote.history).forEach(d => dateSet.add(d));
    holdingValues.filter(h => h.row.quantity !== 0 && h.quote).forEach(h => Object.keys(h.quote!.history).forEach(d => dateSet.add(d)));
    const ibkrHistory = Object.fromEntries(Object.entries(series).map(([id, s]) => [id, Object.fromEntries(s.nav.map(p => [p.date, p.nav]))]));
    // Current manual balances have no transaction history: explicitly a constant scenario.
    const manualTotal = sumKnown(manualValues.map(m => m.value));
    const chart = [...dateSet].sort().filter(d => d <= today).flatMap(date => {
        if (total === null || manualTotal === null) return [];
        const ibkr = sumKnown(accounts.map(a => {
            const data = series[a.id];
            if (!data) return null;
            const nav = valueAt(ibkrHistory[a.id], date);
            const fx = czkRate(quotes, data.currency, date);
            return nav !== null && fx !== null ? nav * fx : null;
        }));
        const btc = pricedValue(btcAmount, btcQuote ? valueAt(btcQuote.history, date) : null, btcQuote ? czkRate(quotes, btcQuote.currency, date) : null);
        const etf = sumKnown(holdingValues.map(({ row, quote }) => pricedValue(row.quantity, quote ? valueAt(quote.history, date) : null, quote ? czkRate(quotes, quote.currency, date) : null)));
        if (ibkr === null || btc === null || etf === null) return [];
        return [{ date, IBKR: ibkr, Bitcoin: btc, ETF: etf, Ostatní: manualTotal, total: ibkr + btc + etf + manualTotal }];
    });
    const first = chart[0], last = chart.at(-1);
    const growth = first && last && first.total > 0 ? { abs: last.total - first.total, pct: (last.total / first.total - 1) * 100, from: first.date } : null;
    return { parts, total, knownTotal, missing, chart, growth, holdingValues, btcQuote, btcValue, ibkrRows, ibkrTotal };
}
