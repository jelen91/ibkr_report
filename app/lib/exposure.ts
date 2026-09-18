import type { PositionItem } from '../types';
import { annotatePutCommitments } from './account';

export type ExposureCategory = 'equities' | 'commodities' | 'crypto';

export interface ExposureRow {
    /** Normalized underlying symbol; also the key for a category override. */
    key: string;
    symbol: string;
    category: ExposureCategory;
    holdings: number;
    puts: number;
    total: number;
}

export interface ExposureResult {
    total: number;
    /** Percent of NAV (0–100 scale), or null when the result is incomplete. */
    percentage: number | null;
    investedHoldings: number;
    putCommitments: number;
    longCalls: number;
    longPuts: number;
    categories: Record<ExposureCategory, number>;
    rows: ExposureRow[];
    /** Human-readable reasons why the known subtotal is not a complete exposure. */
    unsupported: string[];
}

// User's tracking categories, not an inferred economic look-through of every ETF.
// In particular, ETHA stays in equities as in the reference table.
const commodities = new Set(['IAU', 'IGLN', 'WEAT', 'SLV', 'GDX']);
const crypto = new Set(['IBIT', 'FETH', 'PURR', 'LIDO']);
const holdingClasses = new Set(['STK', 'ETF', 'CRYPTO']);
const categories = new Set<ExposureCategory>(['equities', 'commodities', 'crypto']);
const normalize = (symbol: string) => symbol.trim().toUpperCase();
const symbolFor = (p: PositionItem) => normalize(p.value.underlying || (
    p.value.assetClass === 'OPT' ? p.value.symbol.trim().split(/\s+/)[0] : p.value.symbol
));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const account = (p: PositionItem) => p.value.accountId || p.value.accountName;

/**
 * The reference spreadsheet's deployed capital: long holdings at market value
 * plus short-put exercise commitments after eligible same-expiry protection.
 * Purchased options are reported separately. This is neither delta exposure
 * nor IBKR margin, and covered calls do not count the underlying a second time.
 */
export function computeExposure(
    positions: PositionItem[],
    nav: number,
    categoryOverrides: Record<string, ExposureCategory> = {},
): ExposureResult {
    const result: ExposureResult = {
        total: 0, percentage: null, investedHoldings: 0, putCommitments: 0,
        longCalls: 0, longPuts: 0, categories: { equities: 0, commodities: 0, crypto: 0 },
        rows: [], unsupported: [],
    };
    const overrides = new Map(Object.entries(categoryOverrides)
        .filter(([, category]) => categories.has(category))
        .map(([symbol, category]) => [normalize(symbol), category]));
    const rows = new Map<string, ExposureRow>();
    const unsupported = new Set<string>();
    const categoryFor = (p: PositionItem): ExposureCategory => overrides.get(symbolFor(p))
        ?? (p.value.assetClass === 'CRYPTO' || crypto.has(symbolFor(p)) ? 'crypto'
            : commodities.has(symbolFor(p)) ? 'commodities' : 'equities');
    const add = (p: PositionItem, field: 'holdings' | 'puts', amount: number) => {
        const key = symbolFor(p);
        const row = rows.get(key) ?? {
            key, symbol: key, category: categoryFor(p), holdings: 0, puts: 0, total: 0,
        };
        row[field] += amount;
        row.total += amount;
        rows.set(key, row);
    };
    const reject = (p: PositionItem, reason: string) => unsupported.add(`${p.value.symbol}: ${reason}`);
    const valid: PositionItem[] = [];

    for (const p of positions) {
        const v = p.value;
        if (!finite(v.quantity)) { reject(p, 'chybí platný počet kusů'); continue; }
        if (v.quantity === 0 || v.assetClass === 'CASH') continue;
        if (!symbolFor(p)) { reject(p, 'chybí symbol podkladu'); continue; }
        if (!positive(v.fxRateToBase)) { reject(p, 'chybí platný kurz do základní měny'); continue; }
        if (!finite(v.marketValue)) { reject(p, 'chybí platná tržní hodnota'); continue; }
        if (holdingClasses.has(v.assetClass)) {
            if (v.quantity < 0) { reject(p, 'short pozice není zahrnuta v této definici expozice'); continue; }
            if (v.marketValue < 0) { reject(p, 'kladná pozice má zápornou tržní hodnotu'); continue; }
            const amount = v.marketValue * v.fxRateToBase;
            if (!finite(amount)) { reject(p, 'tržní hodnota po přepočtu není platná'); continue; }
            result.investedHoldings += amount;
            add(p, 'holdings', amount);
            valid.push(p);
        } else if (v.assetClass === 'OPT') {
            const type = v.type === 'P' ? 'PUT' : v.type === 'C' ? 'CALL' : v.type;
            if (!['PUT', 'CALL'].includes(type ?? '') || !finite(v.strike) || v.strike < 0 || !positive(v.multiplier)) {
                reject(p, 'chybí platný typ opce, strike nebo násobitel'); continue;
            }
            if (v.quantity > 0 && v.marketValue < 0) {
                reject(p, 'nakoupená opce má zápornou tržní hodnotu'); continue;
            }
            valid.push({ ...p, value: { ...v, type } });
        } else {
            reject(p, `typ instrumentu ${v.assetClass || 'neznámý'} není zahrnut v této definici expozice`);
        }
    }

    // Allocation is local to this calculation and consumes shares only once,
    // including when calls have different strikes, expiries or contract sizes.
    const holdings = valid.filter(p => holdingClasses.has(p.value.assetClass))
        .map(p => ({ p, remaining: p.value.quantity }));
    const covers = (stock: PositionItem, call: PositionItem) => {
        if (!account(stock) || !account(call) || account(stock) !== account(call)
            || (stock.value.model ?? '') !== (call.value.model ?? '') || stock.currency !== call.currency) return false;
        if (stock.value.conid && call.value.underlyingConid) return stock.value.conid === call.value.underlyingConid;
        return symbolFor(stock) === symbolFor(call);
    };
    for (const p of annotatePutCommitments(valid)) {
        const v = p.value;
        if (v.assetClass !== 'OPT') continue;
        if (v.quantity > 0) {
            const amount = v.marketValue * v.fxRateToBase!;
            if (!finite(amount)) { reject(p, 'tržní hodnota po přepočtu není platná'); continue; }
            if (v.type === 'CALL') result.longCalls += amount;
            else result.longPuts += amount;
        } else if (v.type === 'PUT') {
            const amount = v.netCommitedCapital! * v.fxRateToBase!;
            if (!finite(amount) || amount < 0) { reject(p, 'nelze určit závazek z vypsané put opce'); continue; }
            result.putCommitments += amount;
            if (amount > 0) add(p, 'puts', amount);
        } else {
            let remaining = Math.abs(v.quantity) * v.multiplier!;
            for (const stock of holdings) {
                if (!covers(stock.p, p)) continue;
                const covered = Math.min(remaining, stock.remaining);
                stock.remaining -= covered;
                remaining -= covered;
                if (remaining <= 1e-9) break;
            }
            if (remaining > 1e-9 || !finite(remaining)) reject(p, 'vypsaná call opce není plně krytá drženým podkladem');
        }
    }
    result.rows = [...rows.values()].sort((a, b) => b.total - a.total || a.symbol.localeCompare(b.symbol));
    for (const row of result.rows) result.categories[row.category] += row.total;
    result.total = result.investedHoldings + result.putCommitments;
    result.unsupported = [...unsupported];
    if (positive(nav) && !unsupported.size && finite(result.total)) result.percentage = result.total / nav * 100;
    return result;
}
