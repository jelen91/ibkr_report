// Account-level TWR uses end-of-day external flows, as documented by IBKR
// PortfolioAnalyst. Never infer a flow's date by optimizing the resulting return.

export interface NavPoint { date: string; nav: number }
export interface FlowPoint { date: string; amount: number }
export interface TwrPoint {
    date: string;
    index: number;
    nav: number;
    flow: number;
    stale: boolean;
}

export function isValidYmd(date: string): boolean {
    if (!/^\d{8}$/.test(date)) return false;
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
    return d.toISOString().slice(0, 10).replaceAll('-', '') === date;
}

function validateNav(nav: NavPoint[]): void {
    for (let i = 0; i < nav.length; i++) {
        if (!isValidYmd(nav[i].date) || !Number.isFinite(nav[i].nav)
            || (i > 0 && nav[i].date <= nav[i - 1].date)) {
            throw new Error('NAV musí obsahovat platné, jedinečné a vzestupně seřazené dny a konečné částky.');
        }
    }
}

/** A flow between two NAV observations belongs to that interval's ending NAV. */
export function assignFlowLandingDays(nav: NavPoint[], flows: FlowPoint[]): Record<string, number> {
    validateNav(nav);
    const landed: Record<string, number> = {};
    if (!nav.length) return landed;
    for (const flow of flows) {
        if (!isValidYmd(flow.date) || !Number.isFinite(flow.amount)) throw new Error('Neplatný externí peněžní tok.');
        if (flow.date < nav[0].date || flow.date > nav[nav.length - 1].date) continue;
        const day = nav.find(n => n.date >= flow.date)!.date;
        landed[day] = (landed[day] ?? 0) + flow.amount;
    }
    return landed;
}

/** Inception cannot depend on a future account balance or hide small-account losses. */
export function detectInception(nav: NavPoint[]): { inception: string; minNav: number } {
    validateNav(nav);
    return { inception: nav.find(n => n.nav > 0)?.date ?? nav[0]?.date ?? '', minNav: 0 };
}

/** Missing exchange rates must never silently turn into a 1:1 conversion. */
export function rateAt(fx: Record<string, number>, date: string): number {
    const rate = fx[date];
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Chybí platný kurz USD k ${date}. Zapni Daily Conversion Rates ve Flex query.`);
    return rate;
}

export function computeTwr(
    nav: NavPoint[],
    landedFlows: Record<string, number>,
    opts: { minNav?: number; fxToUsd?: Record<string, number> } = {},
): TwrPoint[] {
    validateNav(nav);
    const convert = (date: string, value: number) => opts.fxToUsd ? value / rateAt(opts.fxToUsd, date) : value;
    const out: TwrPoint[] = [];
    let index = 1;
    for (let i = 0; i < nav.length; i++) {
        const { date } = nav[i];
        const end = convert(date, nav[i].nav);
        const flow = convert(date, landedFlows[date] ?? 0);
        if (!Number.isFinite(flow)) throw new Error('Neplatný externí peněžní tok.');
        let stale = true;
        if (i > 0) {
            const begin = convert(nav[i - 1].date, nav[i - 1].nav);
            if (begin > 0) {
                const factor = (end - flow) / begin;
                // A non-positive capital base cannot support a conventional linked
                // return. Keep it unavailable instead of resuming an invented index.
                index = factor >= 0 ? index * factor : NaN;
                stale = !Number.isFinite(index);
            } else if (begin !== 0 || Math.abs(end - flow) > 1e-8) {
                index = NaN;
            }
        }
        out.push({ date, index, nav: end, flow, stale });
    }
    return out;
}

/** Last observed value only; no look-ahead into a future price or FX quote. */
export function valueOnOrBefore(values: Record<string, number>, date: string): number | undefined {
    let found: string | undefined;
    for (const day of Object.keys(values)) {
        if (day <= date && (!found || day > found) && Number.isFinite(values[day]) && values[day] > 0) found = day;
    }
    return found ? values[found] : undefined;
}

/** Carry the USD price first, then apply each day's FX, including US holidays. */
export function benchmarkInCurrency(
    usdPrices: Record<string, number>, dates: string[], fx?: Record<string, number>,
): Record<string, number> {
    const result: Record<string, number> = {};
    for (const date of dates) {
        const price = valueOnOrBefore(usdPrices, date);
        if (fx && !(fx[date] > 0)) continue;
        if (price !== undefined) result[date] = price * (fx ? rateAt(fx, date) : 1);
    }
    return result;
}

export function simulatePassive(
    flows: FlowPoint[], benchmark: Record<string, number>, dates: string[], from: string, startValue: number,
): number {
    const last = dates[dates.length - 1];
    if (!last || !Number.isFinite(startValue) || startValue < 0) return NaN;
    const startPrice = valueOnOrBefore(benchmark, from);
    const endPrice = valueOnOrBefore(benchmark, last);
    if (!startPrice || !endPrice) return NaN;
    let units = startValue / startPrice;
    for (const f of flows) {
        if (f.date <= from || f.date > last) continue;
        const price = valueOnOrBefore(benchmark, f.date);
        if (!price || !Number.isFinite(f.amount)) return NaN;
        units += f.amount / price;
        // A buy-and-hold counterfactual cannot withdraw capital it doesn't own.
        if (units < -1e-8) return NaN;
    }
    return units * endPrice;
}

/** Combine only complete, simultaneous observations; stale NAV invents returns. */
export function mergeNavSeries<T extends {
    accountIds: string[]; currency: string; nav: NavPoint[]; flows: FlowPoint[]; fxToUsd: Record<string, number>;
}>(list: T[]): Pick<T, 'accountIds' | 'currency'> & {
    nav: NavPoint[]; flows: FlowPoint[]; fxToUsd: Record<string, number>; fromDate: string; toDate: string;
} {
    if (!list.length) throw new Error('Chybí řady účtů.');
    const seen = new Set<string>();
    for (const series of list) {
        validateNav(series.nav);
        if (!series.nav.length) throw new Error('Některý účet nemá historii NAV.');
        if (series.currency !== list[0].currency) throw new Error('Účty mají rozdílné bázové měny. Vyber jeden účet; jejich částky nelze přímo sčítat.');
        for (const id of series.accountIds) {
            if (seen.has(id)) throw new Error('Stejný IBKR účet je ve více Flex query. Vyber jednu query, aby se nezapočítal dvakrát.');
            seen.add(id);
        }
    }
    const maps = list.map(s => new Map(s.nav.map(n => [n.date, n.nav])));
    const dates = list[0].nav.map(n => n.date).filter(date => maps.every(m => m.has(date)));
    if (dates.length < 2) throw new Error('Účty nemají alespoň dvě společná data NAV.');
    const flowByDate = new Map<string, number>();
    const fxToUsd: Record<string, number> = {};
    for (const series of list) {
        for (const flow of series.flows) flowByDate.set(flow.date, (flowByDate.get(flow.date) ?? 0) + flow.amount);
        for (const [date, rate] of Object.entries(series.fxToUsd)) {
            if (fxToUsd[date] !== undefined && Math.abs(fxToUsd[date] - rate) > 1e-6 * Math.max(rate, fxToUsd[date])) {
                throw new Error(`Účty obsahují různé směnné kurzy k ${date}.`);
            }
            fxToUsd[date] = rate;
        }
    }
    return {
        accountIds: [...seen], currency: list[0].currency,
        fromDate: dates[0], toDate: dates[dates.length - 1],
        nav: dates.map(date => ({ date, nav: maps.reduce((sum, m) => sum + m.get(date)!, 0) })),
        flows: [...flowByDate].filter(([date]) => date >= dates[0] && date <= dates[dates.length - 1])
            .map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
        fxToUsd,
    };
}

/** A passive holding ledger: contributions buy lots, withdrawals sell FIFO. */
export function simulatePassiveLedger(opts: {
    flows: FlowPoint[];
    prices: Record<string, number>;
    dividends: Record<string, number>;
    fxToBase: Record<string, number>;
    from: string;
    to: string;
    startValue: number;
    dividendRate: number;
    liquidate: boolean;
}): {
    value: number;
    dividendIncomeByYear: Record<string, number>;
    trades: { date: string; assetCategory: string; pnl: number; proceeds: number; holdingDays: number; acquiredDate: string }[];
} | null {
    const priceAt = (date: string) => {
        const usd = valueOnOrBefore(opts.prices, date);
        const fx = valueOnOrBefore(opts.fxToBase, date);
        return usd && fx ? usd * fx : undefined;
    };
    const startPrice = priceAt(opts.from);
    const lastPrice = priceAt(opts.to);
    if (!startPrice || !lastPrice || !Number.isFinite(opts.startValue) || opts.startValue < 0) return null;
    const lots = [{ date: opts.from, units: opts.startValue / startPrice, costPerUnit: startPrice }];
    const trades: { date: string; assetCategory: string; pnl: number; proceeds: number; holdingDays: number; acquiredDate: string }[] = [];
    const dividendIncomeByYear: Record<string, number> = {};
    const flows = new Map<string, number>();
    for (const flow of opts.flows) flows.set(flow.date, (flows.get(flow.date) ?? 0) + flow.amount);
    const dates = [...new Set([...Object.keys(opts.prices), ...Object.keys(opts.dividends), ...flows.keys(), opts.to])]
        .filter(date => date > opts.from && date <= opts.to).sort();
    const sell = (date: string, amount: number, price: number): boolean => {
        let remaining = amount / price;
        for (const lot of lots) {
            const units = Math.min(lot.units, remaining);
            if (units <= 1e-10) continue;
            const d1 = Date.UTC(+lot.date.slice(0, 4), +lot.date.slice(4, 6) - 1, +lot.date.slice(6, 8));
            const d2 = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
            trades.push({ date, assetCategory: 'STK', pnl: units * (price - lot.costPerUnit), proceeds: units * price, holdingDays: (d2 - d1) / 86400000, acquiredDate: lot.date });
            lot.units -= units;
            remaining -= units;
        }
        return remaining <= 1e-8;
    };
    for (const date of dates) {
        const price = priceAt(date);
        const fx = valueOnOrBefore(opts.fxToBase, date);
        if (!price || !fx) return null;
        const dividend = opts.dividends[date] ?? 0;
        if (dividend) {
            const income = lots.reduce((sum, lot) => sum + lot.units, 0) * dividend * fx;
            const year = date.slice(0, 4);
            dividendIncomeByYear[year] = (dividendIncomeByYear[year] ?? 0) + income;
            const net = income * (1 - opts.dividendRate);
            lots.push({ date, units: net / price, costPerUnit: price });
        }
        const amount = flows.get(date) ?? 0;
        if (amount >= 0) lots.push({ date, units: amount / price, costPerUnit: price });
        else if (!sell(date, -amount, price)) return null;
    }
    const value = lots.reduce((sum, lot) => sum + lot.units, 0) * lastPrice;
    if (opts.liquidate && !sell(opts.to, value, lastPrice)) return null;
    return { value, dividendIncomeByYear, trades };
}
