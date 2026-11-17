import { NextResponse, NextRequest } from 'next/server';
import { isValidYmd } from '@/app/lib/twr';
import { fillMissingCloses, lastIntradayCloses, parseDailyChart, ymdToEpoch } from '@/app/lib/benchmarkData';

// Benchmark ve flex query není — IBKR reportuje jen to, co skutečně držíš.
// Bere se tedy zvenčí. Volá se ze serveru, protože Yahoo neposílá CORS hlavičky.
//
// Vrací zavírací ceny bez dividend (`prices`), dividendy podle ex-date a
// Yahoo adjusted close (`closes`, hrubý total return). Osobní srovnání z cen
// a dividend SPY skládá akumulační variantu s 15% srážkou: SPY se zavírá
// v New Yorku ve stejnou chvíli, ke které IBKR oceňuje účet. Cenový index ^GSPC
// by bez dividend podstřeloval o ~1,3 % ročně.

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CACHE_TTL_MS = 60 * 60 * 1000;
// Doplněné nebo chybějící ceny se mohou ještě opravit; „obnovit později“ musí fungovat.
const PROVISIONAL_TTL_MS = 5 * 60 * 1000;

interface BenchmarkPayload {
    symbol: string;
    from: string;
    to: string;
    currency: string;
    closes: Record<string, number>;    // YYYYMMDD → adjusted close v USD (total return)
    prices: Record<string, number>;    // YYYYMMDD → cena bez dividend
    dividends: Record<string, number>; // YYYYMMDD → dividenda na akcii
    /** Dny, kdy Yahoo nemělo denní close a použila se poslední hodinová cena. */
    filledFromIntraday: string[];
    /** Obchodní dny, pro které cena chybí i po doplnění z hodinových dat. */
    missing: string[];
}

const cache = new Map<string, { expires: number; data: BenchmarkPayload }>();

async function fetchChart(symbol: string, period1: number, period2: number, interval: '1d' | '60m') {
    const res = await fetch(
        `${CHART_URL}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=div`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store', signal: AbortSignal.timeout(20000) },
    );
    if (!res.ok) throw new Error(`Yahoo Finance vrátilo ${res.status}`);
    const json = await res.json();
    return json?.chart?.result?.[0];
}

export async function GET(request: NextRequest) {
    const symbol = request.nextUrl.searchParams.get('symbol') || 'SPY';
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    if (!from || !to || !isValidYmd(from) || !isValidYmd(to) || from > to
        || to > new Date().toISOString().slice(0, 10).replaceAll('-', '')) {
        return NextResponse.json({ error: 'Parametry from a to (YYYYMMDD) jsou povinné.' }, { status: 400 });
    }

    if (!['SPY', 'CSPX.L', '^SP500TR', '^GSPC'].includes(symbol)) {
        return NextResponse.json({ error: 'Nepodporovaný benchmark.' }, { status: 400 });
    }

    const key = `${symbol}:${from}:${to}`;
    const hit = cache.get(key);
    if (hit && Date.now() < hit.expires) return NextResponse.json(hit.data);

    // Rezerva na obou koncích: první den portfolia může být svátek nebo víkend
    // a potřebujeme mít z čeho dopočítat cenu zpětně.
    const period1 = ymdToEpoch(from) - 10 * 86400;
    const period2 = ymdToEpoch(to) + 3 * 86400;

    try {
        const result = await fetchChart(symbol, period1, period2, '1d');
        if (!result?.timestamp?.length || !result?.indicators?.adjclose?.[0]?.adjclose?.length) {
            throw new Error('Yahoo Finance nevrátilo použitelná data.');
        }
        if (result.meta?.currency !== 'USD') throw new Error('Benchmark není kotován v USD; přímé porovnání by míchalo měny.');

        const daily = parseDailyChart(result, to);
        let filledFromIntraday: string[] = [];
        if (daily.missing.length) {
            // Hodinová data drží Yahoo zhruba dva roky zpět, což pokrývá 365denní výpis.
            try {
                const first = ymdToEpoch(daily.missing[0]);
                const last = ymdToEpoch(daily.missing.at(-1)!) + 86400;
                const intraday = await fetchChart(symbol, first, last, '60m');
                filledFromIntraday = fillMissingCloses(daily, lastIntradayCloses(intraday));
            } catch (error) {
                console.warn('Doplnění chybějících cen benchmarku selhalo:', error);
            }
        }

        if (!Object.keys(daily.closes).length || !Object.keys(daily.closes).some(date => date >= from)) {
            throw new Error('Benchmark nemá platné závěrečné ceny ve zvoleném období.');
        }
        const missing = daily.missing.filter(date => !filledFromIntraday.includes(date));
        const data: BenchmarkPayload = {
            symbol, from, to, currency: 'USD',
            closes: daily.closes, prices: daily.prices, dividends: daily.dividends, filledFromIntraday, missing,
        };
        const provisional = missing.length > 0 || filledFromIntraday.length > 0;
        cache.set(key, { expires: Date.now() + (provisional ? PROVISIONAL_TTL_MS : CACHE_TTL_MS), data });
        return NextResponse.json(data);
    } catch (error: any) {
        console.error('Benchmark API error:', error);
        return NextResponse.json({ error: String(error?.message ?? error) }, { status: 502 });
    }
}
