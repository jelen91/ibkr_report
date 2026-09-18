import { NextResponse, NextRequest } from 'next/server';
import { parseYahooQuote, parseBtcQuote, type Quote } from '../../lib/quotes';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; data: Quote }>();
const RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);

async function cached(key: string, fn: () => Promise<Quote | null>): Promise<Quote | null> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    try {
        const data = await fn();
        if (data) {
            if (cache.size > 500) cache.clear();
            cache.set(key, { at: Date.now(), data });
        }
        return data;
    } catch {
        // One provider/symbol failing must not discard all successfully loaded prices.
        return null;
    }
}

async function fetchYahoo(symbol: string, range: string): Promise<Quote | null> {
    return cached(`y:${symbol}:${range}`, async () => {
        const res = await fetch(`${YAHOO}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store', signal: AbortSignal.timeout(15000),
        });
        return res.ok ? parseYahooQuote(symbol, await res.json()) : null;
    });
}

async function fetchBtc(): Promise<Quote | null> {
    return cached('btc:365', async () => {
        // The public CoinGecko endpoint supports one year. Keep its actual date coverage;
        // longer requests used to lose even the current BTC valuation after a 401 response.
        const res = await fetch(`${COINGECKO}/coins/bitcoin/market_chart?vs_currency=czk&days=365&interval=daily`, {
            headers: { 'User-Agent': 'ibkr-portfolio-viewer' }, cache: 'no-store', signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
            const quote = parseBtcQuote(await res.json());
            if (quote) return quote;
        }
        // Preserve a dated current valuation if historical data are unavailable.
        const spot = await fetch(`${COINGECKO}/simple/price?ids=bitcoin&vs_currencies=czk&include_last_updated_at=true`, {
            cache: 'no-store', signal: AbortSignal.timeout(15000),
        });
        if (!spot.ok) return null;
        const value = (await spot.json())?.bitcoin;
        return parseBtcQuote({ prices: [[Number(value?.last_updated_at) * 1000, value?.czk]] });
    });
}

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const requested = [...new Set((params.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean))];
    if (requested.length > 25) return NextResponse.json({ error: 'Lze načíst nejvýše 25 různých symbolů.' }, { status: 400 });
    const withBtc = params.get('btc') === '1';
    const requestedCurrencies = (params.get('currencies') || '').split(',').map(c => c.trim().toUpperCase()).filter(c => /^[A-Z]{3}$/.test(c));
    if (new Set(requestedCurrencies).size > 25) return NextResponse.json({ error: 'Lze načíst nejvýše 25 měn.' }, { status: 400 });
    const range = params.get('range') || '1y';
    if (!RANGES.has(range)) return NextResponse.json({ error: 'Nepodporovaný rozsah historie.' }, { status: 400 });
    const [quoteList, eur, usd, btc] = await Promise.all([
        Promise.all(requested.map(s => fetchYahoo(s, range))),
        fetchYahoo('EURCZK=X', range), fetchYahoo('USDCZK=X', range), withBtc ? fetchBtc() : Promise.resolve(null),
    ]);
    const quotes: Record<string, Quote> = {};
    quoteList.forEach((quote, i) => { if (quote) quotes[requested[i]] = quote; });
    const fx: Record<string, Quote> = {
        ...(eur ? { EUR: eur } : {}), ...(usd ? { USD: usd } : {}),
        CZK: { symbol: 'CZK', name: 'Koruna', currency: 'CZK', price: 1, history: {}, asOf: Date.now() },
    };
    // Fetch the actual quoted currency, including GBP after normalizing pence quotes.
    const extraCurrencies = [...new Set([...requestedCurrencies, ...quoteList.flatMap(q => q && /^[A-Z]{3}$/.test(q.currency) ? [q.currency] : [])])]
        .filter(c => !['CZK', 'EUR', 'USD'].includes(c));
    const extra = await Promise.all(extraCurrencies.map(c => fetchYahoo(`${c}CZK=X`, range)));
    extra.forEach((q, i) => { if (q) fx[extraCurrencies[i]] = q; });
    const failed = [
        ...requested.filter(symbol => !quotes[symbol]),
        ...['EUR', 'USD', ...extraCurrencies].filter(c => !fx[c]).map(c => `FX:${c}`),
        ...(withBtc && !btc ? ['BTC'] : []),
    ];
    return NextResponse.json({ quotes, fx, btc, failed, fetchedAt: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
}
