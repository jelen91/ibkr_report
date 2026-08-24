import { NextResponse, NextRequest } from 'next/server';

// Benchmark ve flex query není — IBKR reportuje jen to, co skutečně držíš.
// Bere se tedy zvenčí. Volá se ze serveru, protože Yahoo neposílá CORS hlavičky.
//
// Používá se SPY (S&P 500 ETF) a jeho *adjusted close*, tedy total return
// s reinvestovanými dividendami. Cenový index ^SPX by podstřeloval o ~1,3 % ročně
// a srovnání by vycházelo falešně v tvůj prospěch.

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface BenchmarkPayload {
    symbol: string;
    closes: Record<string, number>;    // YYYYMMDD → adjusted close v USD (total return)
    prices: Record<string, number>;    // YYYYMMDD → cena bez dividend
    dividends: Record<string, number>; // YYYYMMDD → dividenda na akcii
}

const cache = new Map<string, { at: number; data: BenchmarkPayload }>();

const toYmd = (epochSeconds: number) => {
    const d = new Date(epochSeconds * 1000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

const ymdToEpoch = (ymd: string) =>
    Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 1000);

export async function GET(request: NextRequest) {
    const symbol = request.nextUrl.searchParams.get('symbol') || 'SPY';
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    if (!from || !to || from.length !== 8 || to.length !== 8) {
        return NextResponse.json({ error: 'Parametry from a to (YYYYMMDD) jsou povinné.' }, { status: 400 });
    }

    const key = `${symbol}:${from}:${to}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);

    // Rezerva na obou koncích: první den portfolia může být svátek nebo víkend
    // a potřebujeme mít z čeho dopočítat cenu zpětně.
    const period1 = ymdToEpoch(from) - 10 * 86400;
    const period2 = ymdToEpoch(to) + 3 * 86400;

    try {
        const res = await fetch(
            `${CHART_URL}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`Yahoo Finance vrátilo ${res.status}`);

        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const timestamps: number[] | undefined = result?.timestamp;
        const adj: (number | null)[] | undefined = result?.indicators?.adjclose?.[0]?.adjclose;
        const close: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close;

        if (!timestamps || !adj) throw new Error('Yahoo Finance nevrátilo použitelná data.');

        const closes: Record<string, number> = {};
        const prices: Record<string, number> = {};
        timestamps.forEach((t, i) => {
            const ymd = toYmd(t);
            const a = adj[i];
            const c = close?.[i];
            if (typeof a === 'number' && Number.isFinite(a)) closes[ymd] = a;
            if (typeof c === 'number' && Number.isFinite(c)) prices[ymd] = c;
        });

        // Jednotlivé dividendy jsou potřeba pro variantu "po zdanění": adjclose
        // reinvestuje dividendy v hrubé výši, ale investor dostane jen čistou.
        const dividends: Record<string, number> = {};
        const divEvents = result?.events?.dividends ?? {};
        for (const ev of Object.values<any>(divEvents)) {
            if (typeof ev?.amount === 'number' && typeof ev?.date === 'number') {
                const ymd = toYmd(ev.date);
                dividends[ymd] = (dividends[ymd] ?? 0) + ev.amount;
            }
        }

        const data: BenchmarkPayload = { symbol, closes, prices, dividends };
        cache.set(key, { at: Date.now(), data });
        return NextResponse.json(data);
    } catch (error: any) {
        console.error('Benchmark API error:', error);
        return NextResponse.json({ error: String(error?.message ?? error) }, { status: 502 });
    }
}
