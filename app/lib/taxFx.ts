// Český přepočet cizí měny u obchodů (§ 38 odst. 1 ZDP).
//
// Brokerovo P/L přepočtené kurzem dne prodeje nepočítá s tím, že se nákup
// v korunách oceňuje kurzem dne nákupu. Zákon dává na výběr dva způsoby,
// které se musí použít pro všechny příjmy a výdaje v cizí měně za celý rok:
//
//   • denní kurzy: prodej kurzem dne prodeje, nákup kurzem dne nákupu;
//   • jednotný kurz: průměr kurzů ČNB ke konci měsíců, který GFŘ vyhlašuje
//     po skončení roku. Výdaj z jiného roku se přepočte jednotným kurzem
//     roku, kdy vznikl (NSS 2 Afs 4/2019-35).
//
// Kurzy pochází z IBKR (ConversionRates, fxRateToBase), nikoli z ČNB.

import type { RealizedTrade, TaxInputs } from './tax';

export type FxMethod = 'daily' | 'uniform';

/**
 * Jednotné kurzy vyhlášené GFŘ.
 * 2024: Pokyn GFŘ-D-66 (nahradil D-65), https://financnisprava.gov.cz/assets/cs/prilohy/d-sprava-dani-a-poplatku/Pokyn_GFR-D-66.pdf
 * 2025: Pokyn GFŘ-D-75, https://financnisprava.gov.cz/assets/cs/prilohy/d-sprava-dani-a-poplatku/Pokyn_GFR_D-75_podpis.pdf
 */
export const OFFICIAL_UNIFORM_RATES: Record<number, Record<string, number>> = {
    2024: { USD: 23.28, EUR: 25.16 },
    2025: { USD: 21.84, EUR: 24.66 },
};

export interface UniformRate {
    year: number;
    currency: string;
    rate: number;
    /** false = odhad z kurzů IBKR ke konci měsíců, než GFŘ kurz vyhlásí */
    official: boolean;
    months: number;
}

const lastDayOfMonth = (yyyymm: string) => {
    const days = new Date(Date.UTC(+yyyymm.slice(0, 4), +yyyymm.slice(4, 6), 0)).getUTCDate();
    return `${yyyymm}${String(days).padStart(2, '0')}`;
};

/**
 * Official rate when published; otherwise the average of the month-end rates
 * of the months that have ended by `toDate`, like GFŘ computes it from ČNB.
 */
export function uniformRate(year: number, currency: string, monthEndFx: Record<string, Record<string, number>> | undefined,
    toDate: string, baseCurrency = 'CZK'): UniformRate | null {
    if (currency === baseCurrency) return { year, currency, rate: 1, official: true, months: 12 };
    const official = OFFICIAL_UNIFORM_RATES[year]?.[currency];
    if (official) return { year, currency, rate: official, official: true, months: 12 };
    const months = Object.entries(monthEndFx?.[currency] ?? {})
        .filter(([month, rate]) => month.startsWith(String(year)) && lastDayOfMonth(month) <= toDate && rate > 0);
    if (!months.length) return null;
    return { year, currency, rate: months.reduce((sum, [, rate]) => sum + rate, 0) / months.length, official: false, months: months.length };
}

export interface FxConversion {
    tax: TaxInputs;
    /** Kurzy, které jednotný přepočet použil. */
    uniformRates: UniformRate[];
    /** Loty přepočtené zvoleným způsobem. */
    converted: number;
    /** Loty, u kterých chybí kurz, a proto zůstalo brokerovo P/L. */
    fallback: number;
}

/**
 * Converts trades that carry their lot to the chosen method. Trades without a
 * lot stay on broker P/L and lose the `lot` marker when conversion fails, so
 * the tax model can report that part honestly.
 */
export function applyFxMethod(inputs: TaxInputs, method: FxMethod, monthEndFx: Record<string, Record<string, number>> | undefined,
    toDate: string, baseCurrency = 'CZK'): FxConversion {
    const used = new Map<string, UniformRate>();
    let converted = 0;
    let fallback = 0;
    const rate = (year: number, currency: string) => {
        const found = uniformRate(year, currency, monthEndFx, toDate, baseCurrency);
        if (found) used.set(`${year}:${currency}`, found);
        return found?.rate;
    };
    const convert = (trade: RealizedTrade): RealizedTrade => {
        const lot = trade.lot;
        if (!lot) return trade;
        if (method === 'uniform') {
            const closing = rate(Number(trade.date.slice(0, 4)), lot.currency);
            const opening = rate(Number(lot.openDate.slice(0, 4)), lot.currency);
            if (closing !== undefined && opening !== undefined) {
                converted++;
                return { ...trade, pnl: lot.pnl * closing + lot.cost * (closing - opening),
                    proceeds: lot.closeFx > 0 ? trade.proceeds * closing / lot.closeFx : trade.proceeds };
            }
        } else if (lot.openFx !== undefined) {
            converted++;
            return { ...trade, pnl: dailyPnl(trade) };
        }
        fallback++;
        const { lot: _dropped, ...rest } = trade;
        return rest;
    };
    return {
        tax: { ...inputs, trades: inputs.trades.map(convert), unrealized: inputs.unrealized.map(convert) },
        uniformRates: [...used.values()].filter(row => row.currency !== baseCurrency)
            .sort((a, b) => a.year - b.year || a.currency.localeCompare(b.currency)),
        converted, fallback,
    };
}

/** Sale in base currency at the sale-day rate minus purchase at the purchase-day rate. */
export function dailyPnl(trade: RealizedTrade): number {
    const lot = trade.lot;
    if (!lot || lot.openFx === undefined) return trade.pnl;
    return trade.pnl + lot.cost * (lot.closeFx - lot.openFx);
}

/** Month-end rates of several accounts; all come from the same IBKR table. */
export function mergeMonthEndFx(lists: (Record<string, Record<string, number>> | undefined)[]): Record<string, Record<string, number>> | undefined {
    const out: Record<string, Record<string, number>> = {};
    for (const list of lists) for (const [currency, months] of Object.entries(list ?? {})) out[currency] = { ...months, ...out[currency] };
    return Object.keys(out).length ? out : undefined;
}
