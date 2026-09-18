export interface Quote {
    symbol: string;
    name: string;
    currency: string;
    price: number;
    history: Record<string, number>;
    asOf: number; // Unix milliseconds of the provider observation, NOT fetch time.
}

export const quoteDate = (epochMilliseconds: number) => new Date(epochMilliseconds).toISOString().slice(0, 10).replaceAll('-', '');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Yahoo UK prices may be pence (GBp), whereas currency conversion expects GBP. */
export function parseYahooQuote(symbol: string, json: any): Quote | null {
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.currency) return null;
    const currency = meta.currency === 'GBp' || meta.currency === 'GBX' ? 'GBP' : String(meta.currency);
    const factor = meta.currency === 'GBp' || meta.currency === 'GBX' ? 0.01 : 1;
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const history: Record<string, number> = {};
    let lastPrice: number | undefined, lastTime: number | undefined;
    (result.timestamp ?? []).forEach((t: number, i: number) => {
        if (positive(t) && positive(closes[i])) {
            history[quoteDate(t * 1000)] = closes[i] * factor;
            if (lastTime === undefined || t * 1000 > lastTime) { lastPrice = closes[i] * factor; lastTime = t * 1000; }
        }
    });
    const hasMarketQuote = positive(meta.regularMarketPrice) && positive(meta.regularMarketTime);
    const price = hasMarketQuote ? meta.regularMarketPrice * factor : lastPrice;
    const asOf = hasMarketQuote ? meta.regularMarketTime * 1000 : lastTime;
    if (!positive(price) || !positive(asOf)) return null;
    return { symbol, name: String(meta.longName || meta.shortName || symbol), currency, price, history, asOf };
}

export function parseBtcQuote(json: any): Quote | null {
    const prices: [number, number][] = (Array.isArray(json?.prices) ? json.prices : [])
        .filter((row: unknown) => Array.isArray(row) && positive(row[0]) && positive(row[1]))
        .sort((a: number[], b: number[]) => a[0] - b[0]);
    if (!prices.length) return null;
    const history: Record<string, number> = {};
    for (const [ms, value] of prices) history[quoteDate(ms)] = value;
    const [asOf, price] = prices[prices.length - 1];
    return { symbol: 'BTC', name: 'Bitcoin', currency: 'CZK', price, history, asOf };
}
