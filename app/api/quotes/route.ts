import { NextResponse, NextRequest } from 'next/server';

// Ceny pro položky mimo IBKR: ETF přes Yahoo Finance, bitcoin přes CoinGecko
// (Yahoo pár BTC-CZK nenabízí) a měnové kurzy pro přepočet do korun.
//
// Vrací i historii, aby šlo dopočítat vývoj celkového majetku v čase.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS = 15 * 60 * 1000;

export interface Quote {
    symbol: string;
    name: string;
    currency: string;
    price: number;
    history: Record<string, number>; // YYYYMMDD → zavírací cena
}

interface QuotesPayload {
    quotes: Record<string, Quote>;
    fx: Record<string, Quote>;   // EUR, USD → kolik CZK za jednotku
    btc: Quote | null;           // už rovnou v CZK
    fetchedAt: number;
}

const cache = new Map<string, { at: number; data: any }>();

const toYmd = (epochSeconds: number) => {
    const d = new Date(epochSeconds * 1000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T;
    const data = await fn();
    cache.set(key, { at: Date.now(), data });
    return data;
}

async function fetchYahoo(symbol: string, range: string): Promise<Quote | null> {
    return cached(`y:${symbol}:${range}`, async () => {
        const res = await fetch(
            `${YAHOO}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' },
        );
        if (!res.ok) return null;

        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result?.timestamp) return null;

        const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
        const history: Record<string, number> = {};
        result.timestamp.forEach((t: number, i: number) => {
            const v = closes[i];
            if (typeof v === 'number' && Number.isFinite(v)) history[toYmd(t)] = v;
        });

        const meta = result.meta ?? {};
        const lastKnown = Object.keys(history).sort().pop();

        return {
            symbol,
            name: String(meta.longName || meta.shortName || symbol),
            currency: String(meta.currency || 'USD'),
            price: Number(meta.regularMarketPrice ?? (lastKnown ? history[lastKnown] : 0)),
            history,
        } as Quote;
    });
}

async function fetchBtc(days: number): Promise<Quote | null> {
    return cached(`btc:${days}`, async () => {
        const res = await fetch(
            `${COINGECKO}/coins/bitcoin/market_chart?vs_currency=czk&days=${days}&interval=daily`,
            { headers: { 'User-Agent': 'ibkr-portfolio-viewer' }, cache: 'no-store' },
        );
        if (!res.ok) return null;

        const json = await res.json();
        const prices: [number, number][] = json?.prices ?? [];
        if (prices.length === 0) return null;

        const history: Record<string, number> = {};
        for (const [ms, value] of prices) history[toYmd(ms / 1000)] = value;

        return {
            symbol: 'BTC',
            name: 'Bitcoin',
            currency: 'CZK',
            price: prices[prices.length - 1][1],
            history,
        } as Quote;
    });
}

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const symbols = (params.get('symbols') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 25); // ochrana proti zbytečně velkým dotazům
    const withBtc = params.get('btc') === '1';
    const range = params.get('range') || '1y';
    const days = range === '5y' ? 1825 : range === '2y' ? 730 : 365;

    try {
        const [quoteList, eur, usd, btc] = await Promise.all([
            Promise.all(symbols.map(s => fetchYahoo(s, range))),
            fetchYahoo('EURCZK=X', range),
            fetchYahoo('USDCZK=X', range),
            withBtc ? fetchBtc(days) : Promise.resolve(null),
        ]);

        const quotes: Record<string, Quote> = {};
        quoteList.forEach((q, i) => {
            if (q) quotes[symbols[i]] = q;
        });

        const failed = symbols.filter(s => !quotes[s]);

        const payload: QuotesPayload & { failed: string[] } = {
            quotes,
            fx: {
                ...(eur ? { EUR: eur } : {}),
                ...(usd ? { USD: usd } : {}),
                CZK: { symbol: 'CZK', name: 'Koruna', currency: 'CZK', price: 1, history: {} },
            },
            btc,
            failed,
            fetchedAt: Date.now(),
        };

        return NextResponse.json(payload);
    } catch (error: any) {
        console.error('Quotes API error:', error);
        return NextResponse.json({ error: String(error?.message ?? error) }, { status: 502 });
    }
}
