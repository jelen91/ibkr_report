// Zpracování denních a hodinových dat z Yahoo Finance pro benchmark.
//
// Yahoo občas vrátí denní svíčku obchodního dne s prázdnou cenou (u CSPX.L
// například 24.10.2025, 6.3.2026 nebo 16.11.2026). Kdyby to byl poslední den
// výpisu, srovnání by tiše použilo starší cenu ETF s dnešním kurzem USD/CZK.
// Takové dny se proto doplní poslední hodinovou cenou téhož dne; které se
// doplnit nepodaří, vrací API v `missing`, aby je srovnání mohlo ohlásit.

export interface DailyBenchmark {
    closes: Record<string, number>;    // YYYYMMDD → adjusted close (total return)
    prices: Record<string, number>;    // YYYYMMDD → close bez dividend
    dividends: Record<string, number>; // YYYYMMDD → dividenda na akcii
    /** Obchodní dny bez platné závěrečné ceny, které je třeba doplnit. */
    missing: string[];
}

export const toYmd = (epochSeconds: number) => {
    const d = new Date(epochSeconds * 1000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

export const ymdToEpoch = (ymd: string) =>
    Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 1000);

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** True for the bar of a session that is still trading: its value is not a close. */
function isOpenSession(result: any, ymd: string, nowSeconds: number): boolean {
    const regular = result?.meta?.currentTradingPeriod?.regular;
    return Boolean(regular && toYmd(regular.start) === ymd && nowSeconds < regular.end);
}

export function parseDailyChart(result: any, to: string, nowSeconds = Date.now() / 1000): DailyBenchmark {
    const timestamps: number[] = result?.timestamp ?? [];
    const adj: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const close: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const closes: Record<string, number> = {};
    const prices: Record<string, number> = {};
    const missing: string[] = [];
    timestamps.forEach((t, i) => {
        if (!Number.isFinite(t)) return;
        const ymd = toYmd(t);
        if (ymd > to || isOpenSession(result, ymd, nowSeconds)) return;
        if (positive(adj[i])) closes[ymd] = adj[i] as number;
        if (positive(close[i])) prices[ymd] = close[i] as number;
        // A bar that exists without a price is a trading day with lost data.
        if (!positive(close[i]) || !positive(adj[i])) missing.push(ymd);
    });
    const dividends: Record<string, number> = {};
    for (const ev of Object.values<any>(result?.events?.dividends ?? {})) {
        if (Number.isFinite(ev?.amount) && Number.isFinite(ev?.date) && ev.amount >= 0) {
            const ymd = toYmd(ev.date);
            if (ymd <= to) dividends[ymd] = (dividends[ymd] ?? 0) + ev.amount;
        }
    }
    return { closes, prices, dividends, missing: [...new Set(missing)].sort() };
}

/** Last valid hourly price of each day; it is the session's last traded price. */
export function lastIntradayCloses(result: any, nowSeconds = Date.now() / 1000): Record<string, number> {
    const timestamps: number[] = result?.timestamp ?? [];
    const close: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const out: Record<string, { at: number; value: number }> = {};
    timestamps.forEach((t, i) => {
        if (!Number.isFinite(t) || !positive(close[i])) return;
        const ymd = toYmd(t);
        if (isOpenSession(result, ymd, nowSeconds)) return;
        if (!out[ymd] || t > out[ymd].at) out[ymd] = { at: t, value: close[i] as number };
    });
    return Object.fromEntries(Object.entries(out).map(([date, { value }]) => [date, value]));
}

/** Withholding an Irish S&P 500 fund such as CSPX pays on US dividends under the treaty. */
export const FUND_DIVIDEND_WITHHOLDING = 0.15;

/**
 * Accumulating-fund equivalent of a distributing ETF: every dividend is
 * reinvested at the ex-date close after withholding. An ex-date without its
 * own close is reinvested at the next one. Normalized so that the last value
 * equals the last close, like Yahoo's adjusted close.
 */
export function netTotalReturn(prices: Record<string, number>, dividends: Record<string, number>, withholding: number): Record<string, number> {
    const dates = Object.keys(prices).filter(date => positive(prices[date])).sort();
    if (!dates.length) return {};
    const payouts = Object.keys(dividends).filter(date => date > dates[0] && positive(dividends[date])).sort();
    const out: Record<string, number> = { [dates[0]]: prices[dates[0]] };
    let next = 0;
    for (let i = 1; i < dates.length; i++) {
        let dividend = 0;
        while (next < payouts.length && payouts[next] <= dates[i]) dividend += dividends[payouts[next++]];
        out[dates[i]] = out[dates[i - 1]] * (prices[dates[i]] + dividend * (1 - withholding)) / prices[dates[i - 1]];
    }
    const scale = prices[dates.at(-1)!] / out[dates.at(-1)!];
    for (const date of dates) out[date] *= scale;
    return out;
}

/**
 * Fills only the listed missing days. Adjusted close keeps the adjustment ratio
 * of the nearest earlier complete day (dividends change it only on ex-dates).
 */
export function fillMissingCloses(daily: DailyBenchmark, intraday: Record<string, number>): string[] {
    const filled: string[] = [];
    for (const date of daily.missing) {
        const price = intraday[date];
        if (!positive(price)) continue;
        const complete = Object.keys(daily.prices).filter(d => daily.closes[d] && daily.prices[d]).sort();
        const reference = complete.filter(d => d < date).at(-1) ?? complete.find(d => d > date);
        const ratio = reference ? daily.closes[reference] / daily.prices[reference] : 1;
        daily.prices[date] ??= price;
        daily.closes[date] ??= price * ratio;
        filled.push(date);
    }
    return filled;
}
