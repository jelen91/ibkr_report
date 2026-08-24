// Stažení a extrakce dat pro srovnání s benchmarkem.
//
// Záměrně nesdílí kód s /api/account — ta routa zůstává nedotčená. Statement má
// při 365denním období ~6 MB, takže se tady navíc cachuje: v paměti i na disk do
// data/ (dev server se překládá často a paměťová cache by se ztrácela).

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { NavPoint, FlowPoint } from './twr';
import type { TaxInputs, RealizedTrade, CashItem } from './tax';

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const PICKUP_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';

// Stejné jako v /api/account — přechodné chyby IBKR, u kterých má smysl retry.
const RETRYABLE_CODES = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021]);

// Vklady a výběry ve Statement of Funds. Ostatní kódy (BUY, SELL, DIV, FRTAX…)
// jsou vnitřní pohyby portfolia a do cash flow očištění nepatří.
const EXTERNAL_FLOW_CODES = new Set(['DEP', 'WITH']);

// Sekce OptionEAE (uplatnění, přiřazení, expirace opcí) je celá obsažená
// v Trades — u tohoto účtu se shoduje všech 50 tradeID i realizované P/L do
// koruny. Daňové vstupy proto berou výhradně Trades, jinak by expirované opce
// vstoupily do základu dvakrát.
const TAX_TRADE_LEVEL = 'EXECUTION';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_DIR = path.join(process.cwd(), 'data');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true,
});

export interface PerformanceSeries {
    accountIds: string[];
    currency: string;                    // bázová měna účtu
    fromDate: string;
    toDate: string;
    nav: NavPoint[];                     // denní NAV, vzestupně
    flows: FlowPoint[];                  // vklady/výběry
    fxToUsd: Record<string, number>;     // YYYYMMDD → kolik bázové měny za 1 USD
    tax: TaxInputs;                      // podklady pro odhad daně
    fetchedAt: number;
}

const memCache = new Map<string, { at: number; data: PerformanceSeries }>();
const inFlight = new Map<string, Promise<PerformanceSeries>>();

const cacheKey = (token: string, queryId: string) =>
    crypto.createHash('sha256').update(`${token}:${queryId}`).digest('hex').slice(0, 16);

function readDiskCache(key: string): PerformanceSeries | null {
    try {
        const file = path.join(CACHE_DIR, `perf-${key}.json`);
        const raw = fs.readFileSync(file, 'utf-8');
        const data: PerformanceSeries = JSON.parse(raw);
        if (Date.now() - data.fetchedAt > CACHE_TTL_MS) return null;
        return data;
    } catch {
        return null;
    }
}

function writeDiskCache(key: string, data: PerformanceSeries) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(path.join(CACHE_DIR, `perf-${key}.json`), JSON.stringify(data));
    } catch (e) {
        console.warn('Nepodařilo se zapsat cache výkonnosti:', e);
    }
}

const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
    v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export async function getPerformanceSeries(
    token: string,
    queryId: string,
    opts: { force?: boolean } = {},
): Promise<PerformanceSeries> {
    const key = cacheKey(token, queryId);

    if (!opts.force) {
        const mem = memCache.get(key);
        if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.data;

        const disk = readDiskCache(key);
        if (disk) {
            memCache.set(key, { at: disk.fetchedAt, data: disk });
            return disk;
        }
    }

    // Souběžné požadavky sdílí jedno stažení — jinak by se při přepnutí záložky
    // vystřelily dva flex requesty naráz a IBKR vrátí 1018 (rate limit).
    const running = inFlight.get(key);
    if (running) return running;

    const p = (async () => {
        const statements = await fetchFlexStatements(token, queryId);
        const data = extractSeries(statements);
        memCache.set(key, { at: data.fetchedAt, data });
        writeDiskCache(key, data);
        return data;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    return p;
}

async function fetchFlexStatements(token: string, queryId: string): Promise<any[]> {
    const headers = { 'User-Agent': 'Java/1.8.0_202' };

    // 1) Vyžádání reportu
    let referenceCode: string | number | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await axios.get(SEND_URL, { params: { t: token, q: queryId, v: '3' }, headers });
        const root = parser.parse(res.data).FlexStatementResponse ?? parser.parse(res.data);

        if (root.Status !== 'Fail') {
            referenceCode = root.ReferenceCode;
            break;
        }
        const code = Number(root.ErrorCode);
        console.error(`Flex request selhal (pokus ${attempt}/3): ${code} ${root.ErrorMessage}`);
        if (!RETRYABLE_CODES.has(code) || attempt === 3) {
            throw new Error(String(root.ErrorMessage ?? 'Flex request selhal'));
        }
        await new Promise(r => setTimeout(r, 30000));
    }

    if (!referenceCode) throw new Error('IBKR nevrátilo reference code.');

    // 2) Vyzvednutí (report se generuje asynchronně)
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res = await axios.get(PICKUP_URL, {
                params: { t: token, q: referenceCode, v: '3' },
                headers,
            });
            const parsed = parser.parse(res.data);
            const report = parsed.FlexQueryResponse;
            if (report) {
                const list = asArray<any>(report.FlexStatements?.FlexStatement);
                if (list.length === 0) throw new Error('Report neobsahuje žádný FlexStatement.');
                return list;
            }
            const root = parsed.FlexStatementResponse;
            if (root?.Status === 'Fail' && !RETRYABLE_CODES.has(Number(root.ErrorCode))) {
                throw new Error(String(root.ErrorMessage));
            }
        } catch (err) {
            if (err instanceof Error && err.message.includes('FlexStatement')) throw err;
            console.error('Chyba při vyzvedávání reportu:', err);
        }
    }

    throw new Error('Report se nepodařilo vyzvednout (timeout).');
}

/**
 * Vytáhne ze statementu tři řady, které TWR potřebuje. Víc účtů v jednom query
 * se sečte po dnech — TWR se pak počítá nad jejich součtem, což je správně
 * (portfolio jako celek), na rozdíl od průměrování výnosů jednotlivých účtů.
 */
export function extractSeries(statements: any[]): PerformanceSeries {
    const navByDate = new Map<string, number>();
    const flowByDate = new Map<string, number>();
    const fxToUsd: Record<string, number> = {};
    const accountIds: string[] = [];

    const tax: TaxInputs = {
        trades: [],
        unrealized: [],
        dividends: [],
        dividendWithheld: [],
        interest: [],
        interestWithheld: [],
    };

    let currency = 'CZK';
    let fromDate = '';
    let toDate = '';

    for (const stmt of statements) {
        if (stmt.accountId) accountIds.push(String(stmt.accountId));
        if (stmt.fromDate && (!fromDate || String(stmt.fromDate) < fromDate)) fromDate = String(stmt.fromDate);
        if (stmt.toDate && (!toDate || String(stmt.toDate) > toDate)) toDate = String(stmt.toDate);

        // --- denní NAV ---
        for (const row of asArray<any>(stmt.EquitySummaryInBase?.EquitySummaryByReportDateInBase)) {
            const date = String(row.reportDate ?? '');
            const total = Number(row.total);
            if (!date || !Number.isFinite(total)) continue;
            navByDate.set(date, (navByDate.get(date) ?? 0) + total);
            if (row.currency) currency = String(row.currency);
        }

        // --- vklady, výběry a položky §8 (dividendy, úroky, sražená daň) ---
        for (const row of asArray<any>(stmt.StmtFunds?.StatementOfFundsLine)) {
            if (String(row.levelOfDetail) !== 'BaseCurrency') continue;
            const date = String(row.date ?? '');
            const amount = Number(row.amount);
            if (!date || !Number.isFinite(amount)) continue;
            const code = String(row.activityCode);

            if (EXTERNAL_FLOW_CODES.has(code)) {
                flowByDate.set(date, (flowByDate.get(date) ?? 0) + amount);
                continue;
            }

            const item: CashItem = { date, amount };
            if (code === 'DIV') tax.dividends.push(item);
            else if (code === 'CINT' || code === 'DINT') tax.interest.push(item);
            else if (code === 'FRTAX') {
                // IBKR srazí 20 % i z připsaných úroků, nejen z dividend. Rozliší
                // se to podle toho, jestli je řádek navázaný na konkrétní titul.
                // (Storno páry se sečtou samy — pracuje se se součtem, ne s jednotlivými řádky.)
                if (row.symbol) tax.dividendWithheld.push(item);
                else tax.interestWithheld.push(item);
            }
        }

        // --- realizované obchody pro §10 ---
        tax.trades.push(...extractRealizedTrades(stmt));

        // --- otevřené pozice pro scénář likvidace ---
        for (const pos of asArray<any>(stmt.OpenPositions?.OpenPosition)) {
            if (String(pos.levelOfDetail ?? '').toUpperCase() !== 'SUMMARY') continue;
            const fx = Number(pos.fxRateToBase ?? 1);
            const pnl = Number(pos.fifoPnlUnrealized ?? 0) * fx;
            if (!Number.isFinite(pnl) || pnl === 0) continue;
            const value = Number(pos.positionValue ?? 0) * fx;
            tax.unrealized.push({
                date: String(pos.reportDate ?? ''),
                assetCategory: String(pos.assetCategory ?? ''),
                pnl,
                proceeds: value > 0 ? value : 0,
                // I OpenPositions má u tohoto účtu prázdné openDateTime, takže
                // časový test u otevřených pozic ověřit nejde → zdanitelné.
                holdingDays: null,
            });
        }

        // --- denní kurz USD → bázová měna (přímo od IBKR, tedy stejný, jakým
        //     přeceňuje NAV; externí FX zdroj by zaváděl vlastní odchylku) ---
        for (const row of asArray<any>(stmt.ConversionRates?.ConversionRate)) {
            if (String(row.fromCurrency) !== 'USD') continue;
            if (String(row.toCurrency) !== currency) continue;
            const date = String(row.reportDate ?? '');
            const rate = Number(row.rate);
            if (date && Number.isFinite(rate) && rate > 0) fxToUsd[date] = rate;
        }
    }

    const nav: NavPoint[] = [...navByDate.entries()]
        .map(([date, v]) => ({ date, nav: v }))
        .sort((a, b) => a.date.localeCompare(b.date));

    const flows: FlowPoint[] = [...flowByDate.entries()]
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date));

    // Kurzy nejsou na všechny dny (svátky, první den mimo rozsah query) → dorovnat
    // posledním známým, případně prvním dopředu.
    fillFxGaps(fxToUsd, nav.map(n => n.date));

    tax.trades.sort((a, b) => a.date.localeCompare(b.date));

    return {
        accountIds,
        currency,
        fromDate,
        toDate,
        nav,
        flows,
        fxToUsd,
        tax,
        fetchedAt: Date.now(),
    };
}

/**
 * Realizované obchody s dopočítanou dobou držení.
 *
 * IBKR má ve flexu pole `openDateTime` i `holdingPeriodDateTime`, jenže u tohohle
 * účtu přicházejí prázdná (u všech 142 uzavíracích obchodů), takže časový test
 * z nich přečíst nejde. Doba držení se proto rekonstruuje FIFO párováním
 * otevíracích a uzavíracích obchodů v rámci staženého období — což pokrývá
 * všechno, co se otevřelo i zavřelo uvnitř okna.
 *
 * Co se spárovat nepodaří (pozice otevřená před začátkem období), dostane
 * `holdingDays: null` a v daňovém modelu se počítá jako zdanitelné. To je
 * konzervativní směr: raději daň nadhodnotit než tvrdit osvobození, které
 * z dat neplyne.
 */
function extractRealizedTrades(stmt: any): RealizedTrade[] {
    const rows = asArray<any>(stmt.Trades?.Trade)
        .filter(t => String(t.levelOfDetail) === TAX_TRADE_LEVEL)
        .map(t => ({
            date: String(t.tradeDate ?? ''),
            dateTime: String(t.dateTime ?? ''),
            conid: String(t.conid ?? ''),
            assetCategory: String(t.assetCategory ?? ''),
            quantity: Number(t.quantity ?? 0),
            proceeds: Number(t.proceeds ?? 0) * Number(t.fxRateToBase ?? 1),
            pnl: Number(t.fifoPnlRealized ?? 0) * Number(t.fxRateToBase ?? 1),
            openClose: String(t.openCloseIndicator ?? ''),
        }))
        .filter(t => t.date)
        .sort((a, b) => (a.date + a.dateTime).localeCompare(b.date + b.dateTime));

    // Otevřené loty na instrument: [den otevření, zbývající množství]
    const lots = new Map<string, { date: string; qty: number }[]>();
    const out: RealizedTrade[] = [];

    for (const t of rows) {
        const isOpen = t.openClose.includes('O');
        const isClose = t.openClose.includes('C');

        if (isClose) {
            const queue = lots.get(t.conid) ?? [];
            let remaining = Math.abs(t.quantity);
            let matched = 0;
            let weightedDays = 0;

            while (remaining > 1e-9 && queue.length > 0) {
                const lot = queue[0];
                const take = Math.min(remaining, Math.abs(lot.qty));
                weightedDays += daysBetween(lot.date, t.date) * take;
                matched += take;
                remaining -= take;
                lot.qty = lot.qty > 0 ? lot.qty - take : lot.qty + take;
                if (Math.abs(lot.qty) < 1e-9) queue.shift();
            }

            const total = Math.abs(t.quantity);
            // Doba držení je vážený průměr napárovaných lotů; když se nepodařilo
            // dohledat všechno, je celý obchod raději bez známé doby držení.
            const holdingDays =
                matched > 0 && remaining <= 1e-9 ? Math.round(weightedDays / matched) : null;

            out.push({
                date: t.date,
                assetCategory: t.assetCategory,
                pnl: t.pnl,
                // Do hodnotového testu jde hrubý příjem z prodeje, tedy jen
                // uzavírky prodejem (u short pozic se pozice zavírá nákupem).
                proceeds: t.quantity < 0 ? Math.abs(t.proceeds) : 0,
                holdingDays,
            });

            if (queue.length === 0) lots.delete(t.conid);
            else lots.set(t.conid, queue);
        }

        if (isOpen) {
            const queue = lots.get(t.conid) ?? [];
            queue.push({ date: t.date, qty: t.quantity });
            lots.set(t.conid, queue);
        }
    }

    return out;
}

function daysBetween(from: string, to: string): number {
    const a = Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8));
    const b = Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8));
    return Math.round((b - a) / 86400000);
}

function fillFxGaps(fx: Record<string, number>, dates: string[]) {
    let last = 0;
    for (const d of dates) {
        if (fx[d]) last = fx[d];
        else if (last) fx[d] = last;
    }
    // dny před prvním známým kurzem
    const firstKnown = dates.find(d => fx[d]);
    if (!firstKnown) return;
    for (const d of dates) {
        if (d >= firstKnown) break;
        fx[d] = fx[firstKnown];
    }
}
