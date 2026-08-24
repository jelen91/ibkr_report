'use client';

import { useState, useEffect, useMemo } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Account } from '../types';
import {
    assignFlowLandingDays, computeTwr, detectInception, simulatePassive,
    type NavPoint, type FlowPoint,
} from '../lib/twr';
import {
    computeTax, taxLiabilityByDate, summarizeTax, benchmarkTax, effectiveRate,
    selfEmployedTaxBase, computeSelfEmployed, LOWER_RATE, UPPER_RATE,
    DEFAULT_TAX_SETTINGS, DEFAULT_SELF_EMPLOYED, FLAT_TAX_INCOME_LIMIT,
    DEFAULT_FLAT_TAX_MONTHLY,
    type TaxInputs, type TaxSettings, type RateMode, type ExpenseMode,
} from '../lib/tax';

interface PerformanceSeries {
    accountIds: string[];
    currency: string;
    fromDate: string;
    toDate: string;
    nav: NavPoint[];
    flows: FlowPoint[];
    fxToUsd: Record<string, number>;
    tax: TaxInputs;
}

interface BenchmarkData {
    closes: Record<string, number>;
    prices: Record<string, number>;
    dividends: Record<string, number>;
}

type Range = '1M' | '3M' | '6M' | 'YTD' | 'MAX';
type Currency = 'CZK' | 'USD';

const RANGES: { key: Range; label: string }[] = [
    { key: '1M', label: '1 měsíc' },
    { key: '3M', label: '3 měsíce' },
    { key: '6M', label: '6 měsíců' },
    { key: 'YTD', label: 'Letos' },
    { key: 'MAX', label: 'Vše' },
];

// Varianty benchmarku. Liší se hlavně tím, jestli obsahují dividendy — a to je
// rozdíl kolem 0,7 procentního bodu za 7 měsíců, takže právě tady vzniká nesoulad
// proti číslu, které člověk vidí ve zprávách nebo v jiné appce.
//   `distributing` = ETF vyplácí dividendy → podléhají srážkové dani a počítají
//   se do limitu paušálního režimu. Akumulační ETF a indexy nevyplácí nic.
const BENCHMARKS = [
    { symbol: 'SPY', short: 'SPY', label: 'SPY — ETF na S&P 500, vč. dividend', distributing: true },
    { symbol: 'CSPX.L', short: 'CSPX', label: 'CSPX — akumulační ETF, nevyplácí', distributing: false },
    { symbol: '^SP500TR', short: 'S&P 500 TR', label: 'S&P 500 Total Return (oficiální index)', distributing: false },
    { symbol: '^GSPC', short: 'S&P 500', label: 'S&P 500 cenový index — bez dividend', distributing: false },
];

const PORTFOLIO_COLOR = '#38bdf8';
const BENCHMARK_COLOR = '#f59e0b';

const LS_ACCOUNTS = 'ibkr_accounts';
const LS_PREFS = 'ibkr_perf_prefs';

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (ymd: string) =>
    ymd.length === 8 ? `${ymd.slice(6, 8)}.${ymd.slice(4, 6)}.${ymd.slice(0, 4)}` : ymd;

const fmtDateShort = (ymd: string) =>
    ymd.length === 8 ? `${+ymd.slice(6, 8)}.${+ymd.slice(4, 6)}.` : ymd;

const fmtPct = (v: number, digits = 2) =>
    (v >= 0 ? '+' : '') + v.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' %';

const fmtMoney = (v: number, cur: string) =>
    Math.round(v).toLocaleString('cs-CZ') + ' ' + cur;

const daysBetween = (from: string, to: string) => Math.round(
    (Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8))
        - Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8))) / 86400000,
);

/** Posune datum YYYYMMDD o N měsíců zpět. */
function monthsBack(ymd: string, months: number): string {
    const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
    d.setUTCMonth(d.getUTCMonth() - months);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Sloučí řady z více účtů. NAV se sčítá po dnech; pokud některý účet v daný den
 * řádek nemá (jiné datum otevření, svátek na jiné burze), použije se jeho
 * poslední známá hodnota — jinak by celkové portfolio ten den umělě propadlo.
 */
function mergeSeries(list: PerformanceSeries[]): PerformanceSeries | null {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];

    const allDates = [...new Set(list.flatMap(s => s.nav.map(n => n.date)))].sort();
    const nav: NavPoint[] = allDates.map(date => ({ date, nav: 0 }));

    for (const s of list) {
        const byDate = new Map(s.nav.map(n => [n.date, n.nav]));
        let last = 0;
        let started = false;
        allDates.forEach((date, i) => {
            const v = byDate.get(date);
            if (v !== undefined) { last = v; started = true; }
            if (started) nav[i].nav += last;
        });
    }

    const flowByDate = new Map<string, number>();
    for (const s of list) {
        for (const f of s.flows) flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + f.amount);
    }

    return {
        accountIds: list.flatMap(s => s.accountIds),
        currency: list[0].currency,
        fromDate: allDates[0],
        toDate: allDates[allDates.length - 1],
        nav,
        flows: [...flowByDate.entries()]
            .map(([date, amount]) => ({ date, amount }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        fxToUsd: Object.assign({}, ...list.map(s => s.fxToUsd)),
        // Daňové vstupy se slučují prostým spojením — základ daně je jeden
        // za poplatníka, ne za účet.
        tax: {
            trades: list.flatMap(s => s.tax.trades),
            unrealized: list.flatMap(s => s.tax.unrealized),
            dividends: list.flatMap(s => s.tax.dividends),
            dividendWithheld: list.flatMap(s => s.tax.dividendWithheld),
            interest: list.flatMap(s => s.tax.interest),
            interestWithheld: list.flatMap(s => s.tax.interestWithheld),
        },
    };
}

// ─── component ────────────────────────────────────────────────────────────────

export default function PerformancePage() {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [activeId, setActiveId] = useState<string | 'all'>('all');
    const [series, setSeries] = useState<Record<string, PerformanceSeries>>({});
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [benchmark, setBenchmark] = useState<BenchmarkData | null>(null);
    const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
    const [range, setRange] = useState<Range>('MAX');
    const [currency, setCurrency] = useState<Currency>('CZK');
    const [benchmarkSymbol, setBenchmarkSymbol] = useState('SPY');
    const [afterTax, setAfterTax] = useState(true);
    const rateMode: RateMode = 'auto'; // progrese se určí ze základu, ruční přepínač není potřeba
    const [businessIncome, setBusinessIncome] = useState(0);
    const [expenseRate, setExpenseRate] = useState(0.6);
    const [expenseMode, setExpenseMode] = useState<ExpenseMode>('lump');
    const [actualExpenses, setActualExpenses] = useState(0);
    const [flatTaxRegime, setFlatTaxRegime] = useState(true);
    const [flatTaxMonthly, setFlatTaxMonthly] = useState(DEFAULT_FLAT_TAX_MONTHLY);
    const [liquidate, setLiquidate] = useState(false);

    // Viz komentář ve stejném místě v přehledu majetku: bez téhle pojistky
    // StrictMode při mountu přepíše uložené nastavení výchozími hodnotami.
    const [hydrated, setHydrated] = useState(false);

    // Dílčí základ §7 z obratu a výdajového paušálu — pásmo pod hranicí progrese
    // zaplní on, ne investice.
    const otherTaxBase = expenseMode === 'actual'
        ? Math.max(0, businessIncome - actualExpenses)
        : selfEmployedTaxBase(businessIncome, expenseRate);

    // ── init ──
    useEffect(() => {
        try {
            const raw = localStorage.getItem(LS_ACCOUNTS);
            const saved: Account[] = raw ? JSON.parse(raw) : [];
            setAccounts(saved);
            setActiveId(saved.length === 1 ? saved[0].id : 'all');
            saved.forEach(a => fetchSeries(a));
        } catch { /* prázdný localStorage → prázdný stav níž */ }

        try {
            const prefs = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
            if (prefs.currency === 'USD' || prefs.currency === 'CZK') setCurrency(prefs.currency);
            if (RANGES.some(r => r.key === prefs.range)) setRange(prefs.range);
            if (BENCHMARKS.some(b => b.symbol === prefs.benchmarkSymbol)) setBenchmarkSymbol(prefs.benchmarkSymbol);
            if (typeof prefs.afterTax === 'boolean') setAfterTax(prefs.afterTax);
            if (typeof prefs.businessIncome === 'number') setBusinessIncome(prefs.businessIncome);
            if (typeof prefs.expenseRate === 'number') setExpenseRate(prefs.expenseRate);
            if (prefs.expenseMode === 'lump' || prefs.expenseMode === 'actual') setExpenseMode(prefs.expenseMode);
            if (typeof prefs.actualExpenses === 'number') setActualExpenses(prefs.actualExpenses);
            if (typeof prefs.flatTaxRegime === 'boolean') setFlatTaxRegime(prefs.flatTaxRegime);
            if (typeof prefs.flatTaxMonthly === 'number') setFlatTaxMonthly(prefs.flatTaxMonthly);
            if (typeof prefs.liquidate === 'boolean') setLiquidate(prefs.liquidate);
        } catch { /* výchozí hodnoty */ }

        setHydrated(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        localStorage.setItem(LS_PREFS, JSON.stringify({
            currency, range, benchmarkSymbol, afterTax, businessIncome, expenseRate,
            expenseMode, actualExpenses, flatTaxRegime, flatTaxMonthly, liquidate,
        }));
    }, [hydrated, currency, range, benchmarkSymbol, afterTax, businessIncome, expenseRate,
        expenseMode, actualExpenses, flatTaxRegime, flatTaxMonthly, liquidate]);

    async function fetchSeries(acct: Account, force = false) {
        setLoadingIds(prev => new Set(prev).add(acct.id));
        setErrors(prev => { const e = { ...prev }; delete e[acct.id]; return e; });
        try {
            const res = await fetch(`/api/performance${force ? '?force=1' : ''}`, {
                headers: { 'x-flex-token': acct.token, 'x-flex-query-id': acct.queryId },
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Chyba načítání');
            setSeries(prev => ({ ...prev, [acct.id]: json }));
        } catch (e: any) {
            setErrors(prev => ({ ...prev, [acct.id]: e.message }));
        } finally {
            setLoadingIds(prev => { const s = new Set(prev); s.delete(acct.id); return s; });
        }
    }

    // ── sloučená řada podle vybrané záložky ──
    const merged = useMemo(() => {
        const selected = activeId === 'all'
            ? accounts.map(a => series[a.id]).filter(Boolean)
            : [series[activeId]].filter(Boolean);
        return mergeSeries(selected as PerformanceSeries[]);
    }, [accounts, series, activeId]);

    // ── benchmark ──
    useEffect(() => {
        if (!merged || merged.nav.length < 2) return;
        const from = merged.nav[0].date;
        const to = merged.nav[merged.nav.length - 1].date;
        setBenchmarkError(null);
        fetch(`/api/benchmark?symbol=${encodeURIComponent(benchmarkSymbol)}&from=${from}&to=${to}`)
            .then(async res => {
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || 'Chyba benchmarku');
                setBenchmark(json);
            })
            .catch(e => setBenchmarkError(e.message));
    }, [merged?.fromDate, merged?.toDate, merged?.nav.length, benchmarkSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── výpočet ──
    const view = useMemo(() => {
        if (!merged || merged.nav.length < 2) return null;

        const { inception, minNav } = detectInception(merged.nav);
        const landed = assignFlowLandingDays(merged.nav, merged.flows);
        const fx = merged.fxToUsd;

        const dates = merged.nav.map(n => n.date);
        const lastDate = dates[dates.length - 1];

        const taxSettings: TaxSettings = { ...DEFAULT_TAX_SETTINGS, rateMode, otherTaxBase, liquidate };
        const flatTaxYear = flatTaxRegime ? flatTaxMonthly * 12 : 0;

        // Sazba na další korunu investičního příjmu. Používá se pro benchmark,
        // kde se daní jen dividendy (drobné částky, u kterých nemá smysl řešit
        // rozdělení mezi pásma).
        const marginalRate = otherTaxBase >= taxSettings.progressiveThreshold ? UPPER_RATE : LOWER_RATE;
        const benchmarkMeta = BENCHMARKS.find(b => b.symbol === benchmarkSymbol) ?? BENCHMARKS[0];
        // Akumulační ETF ani cenový index nic nevyplácí → není co danit.
        const dividendRate = afterTax && benchmarkMeta.distributing ? marginalRate : 0;

        // Daňový závazek se odečítá od NAV v bázové měně; převod do USD si pak
        // udělá computeTwr sám kurzem daného dne.
        const liability = afterTax ? taxLiabilityByDate(merged.tax, taxSettings, dates) : null;
        const navSeries = liability
            ? merged.nav.map(n => ({ date: n.date, nav: n.nav - (liability[n.date] ?? 0) }))
            : merged.nav;

        const twr = computeTwr(navSeries, landed, {
            minNav,
            fxToUsd: currency === 'USD' ? fx : undefined,
        });

        // začátek období — nikdy dřív, než byl účet reálně zafinancovaný
        let wanted: string;
        if (range === 'MAX') wanted = inception;
        else if (range === 'YTD') wanted = `${lastDate.slice(0, 4)}0101`;
        else wanted = monthsBack(lastDate, range === '1M' ? 1 : range === '3M' ? 3 : 6);

        const startDate = dates.find(d => d >= wanted && d >= inception) ?? inception;
        const clamped = wanted < inception && range !== 'MAX';

        const twrBy = new Map(twr.map(p => [p.date, p]));
        const startIndex = twrBy.get(startDate)?.index ?? 1;

        // Index benchmarku v USD. Před zdaněním je to prostě adjusted close
        // (dividendy reinvestované v hrubé výši). Po zdanění se musí složit
        // ručně z ceny a jednotlivých dividend, protože investor reinvestuje
        // jen to, co mu po srážkové dani zůstane.
        const benchUsd: Record<string, number> = {};
        if (benchmark) {
            if (!afterTax) {
                Object.assign(benchUsd, benchmark.closes);
            } else {
                const priceDates = Object.keys(benchmark.prices).sort();
                let index = 1;
                let prev: number | null = null;
                for (const d of priceDates) {
                    const price = benchmark.prices[d];
                    const div = (benchmark.dividends[d] ?? 0) * (1 - dividendRate);
                    if (prev !== null && prev > 0) index *= (price + div) / prev;
                    prev = price;
                    benchUsd[d] = index;
                }
            }
        }

        // do CZK přes denní kurz IBKR
        const benchIn = (d: string): number | null => {
            const usd = benchUsd[d];
            if (usd === undefined) return null;
            return currency === 'USD' ? usd : usd * (fx[d] || 0);
        };

        // dopředné doplnění benchmarku na dny, kdy byla US burza zavřená
        const benchSeries: Record<string, number> = {};
        let lastBench: number | null = null;
        for (const d of dates) {
            const v = benchIn(d);
            if (v !== null && Number.isFinite(v)) lastBench = v;
            if (lastBench !== null) benchSeries[d] = lastBench;
        }
        const benchStart = benchSeries[startDate];

        // Ve scénáři likvidace se zdaní i kapitálový zisk indexu — jinak by
        // srovnání bylo nespravedlivé: portfolio by dostalo daň i z nerealizovaných
        // zisků, zatímco index by prodával bez daně.
        const holdingDays = daysBetween(startDate, lastDate);

        // Sazba na kapitálový zisk indexu se určuje z jeho absolutní výše
        // v bázové měně, aby se korektně rozdělila mezi pásma 15 % a 23 %.
        const navBaseAtStart = merged.nav.find(n => n.date === startDate)?.nav ?? 0;
        const finalRatio = benchStart && benchSeries[lastDate] ? benchSeries[lastDate] / benchStart : 1;
        const benchCapitalRate = effectiveRate(Math.max(0, (finalRatio - 1) * navBaseAtStart), taxSettings);

        const netBenchReturn = (ratio: number) => {
            const gross = ratio - 1;
            if (!afterTax || !liquidate || gross <= 0) return gross;
            if (holdingDays >= taxSettings.timeTestDays) return gross;
            return gross * (1 - benchCapitalRate);
        };

        const rows = dates
            .filter(d => d >= startDate)
            .map(d => ({
                date: d,
                portfolio: ((twrBy.get(d)!.index / startIndex) - 1) * 100,
                benchmark: benchStart && benchSeries[d]
                    ? netBenchReturn(benchSeries[d] / benchStart) * 100
                    : null,
            }));

        const portfolioReturn = rows[rows.length - 1]?.portfolio ?? 0;
        const benchmarkReturn = rows[rows.length - 1]?.benchmark ?? null;

        // pasivní protipól: stejné vklady, ale do SPY
        const flowsInCurrency: FlowPoint[] = Object.entries(landed).map(([date, amount]) => ({
            date,
            amount: currency === 'USD' ? amount / (fx[date] || 1) : amount,
        }));
        const startNav = twrBy.get(startDate)?.nav ?? 0;
        const actualNav = twrBy.get(lastDate)?.nav ?? 0;

        const depositsInPeriod = flowsInCurrency
            .filter(f => f.date > startDate && f.date <= lastDate)
            .reduce((s, f) => s + f.amount, 0);

        let passiveNav = benchStart
            ? simulatePassive(flowsInCurrency, benchSeries, dates, startDate, startNav)
            : NaN;
        let passiveTax = 0;
        if (Number.isFinite(passiveNav) && afterTax) {
            passiveTax = benchmarkTax({
                startValue: startNav + depositsInPeriod,
                endValueBeforeCapitalTax: passiveNav,
                sold: liquidate,
                holdingDays,
                settings: taxSettings,
            });
            passiveNav -= passiveTax;
        }

        // rozpad daně za celé stažené období (ne jen za vybraný rozsah — daň se
        // podává za kalendářní rok jako celek)
        const taxYears = computeTax(merged.tax, taxSettings);
        const taxSummary = summarizeTax(taxYears);
        const investmentBase = taxYears.reduce((sum, y) => sum + y.investmentBase, 0);

        // Překročení limitu §8/§9/§10 znamená konec paušálního režimu pro celý rok.
        const flatTaxBroken = taxSummary.grossIncome > FLAT_TAX_INCOME_LIMIT;

        const selfEmployed = computeSelfEmployed({
            ...DEFAULT_SELF_EMPLOYED,
            income: businessIncome,
            expenseMode,
            expenseRate,
            actualExpenses,
            flatTaxPaid: flatTaxYear,
        }, investmentBase, taxSettings);

        // Alternativa pro rozhodnutí "paušál vs. skutečné výdaje"
        const selfEmployedAlt = computeSelfEmployed({
            ...DEFAULT_SELF_EMPLOYED,
            income: businessIncome,
            expenseMode: expenseMode === 'lump' ? 'actual' : 'lump',
            expenseRate,
            actualExpenses,
            flatTaxPaid: flatTaxYear,
        }, investmentBase, taxSettings);
        const taxInPeriod = liability
            ? (liability[lastDate] ?? 0) - (liability[startDate] ?? 0)
            : 0;

        // ── srovnání "kolik mi nakonec zůstane" ──────────────────────────────
        // Obě strany musí nést všechny své náklady, jinak srovnání lže. Portfolio
        // platí daň ze zisků a případně ztrátu paušálního režimu; index platí
        // srážkovou daň z dividend (ta je už započtená v jeho indexu) a ztratil
        // by paušál taky, kdyby jeho dividendy překročily limit.

        // Hrubá hodnota účtu bez odečtené daně — twr série ji už má sníženou.
        const navGrossEnd = (() => {
            const raw = merged.nav[merged.nav.length - 1]?.nav ?? 0;
            return currency === 'USD' ? raw / (fx[lastDate] || 1) : raw;
        })();

        const inDisplay = (baseAmount: number) =>
            currency === 'USD' ? baseAmount / (fx[lastDate] || 1) : baseAmount;

        // Ztráta paušálu je celoroční položka, ne poměrná část období.
        // Bez zadaného obratu není s čím paušál srovnávat — model by pak tvrdil,
        // že trading ušetřil peníze, což by byl nesmysl.
        const regimeKnown = flatTaxRegime && businessIncome > 0;
        const regimeCost = afterTax && regimeKnown && flatTaxBroken
            ? inDisplay(selfEmployed.regimeChangeCost)
            : 0;

        const tradingFinal = navGrossEnd - taxInPeriod - regimeCost;

        // Odhad dividend, které by index za období vyplatil: součet dílčích
        // výnosů (dividenda / cena) krát průměrná hodnota pozice.
        const passiveDividendIncome = (() => {
            if (!benchmarkMeta.distributing) return 0;
            if (!benchmark || !Number.isFinite(passiveNav)) return 0;
            let yieldSum = 0;
            for (const [d, amount] of Object.entries(benchmark.dividends)) {
                if (d < startDate || d > lastDate) continue;
                const price = benchmark.prices[d];
                if (price > 0) yieldSum += amount / price;
            }
            const avgValue = (startNav + passiveNav) / 2;
            return avgValue * yieldSum;
        })();

        // Limit se posuzuje za kalendářní rok; u kratšího období je tohle odhad.
        const passiveBreaksFlatTax =
            currency === 'USD'
                ? passiveDividendIncome * (fx[lastDate] || 1) > FLAT_TAX_INCOME_LIMIT
                : passiveDividendIncome > FLAT_TAX_INCOME_LIMIT;

        const passiveRegimeCost = afterTax && regimeKnown && passiveBreaksFlatTax
            ? inDisplay(selfEmployed.regimeChangeCost)
            : 0;

        const passiveFinal = Number.isFinite(passiveNav) ? passiveNav - passiveRegimeCost : NaN;
        const verdict = Number.isFinite(passiveFinal) ? tradingFinal - passiveFinal : NaN;

        return {
            rows, startDate, lastDate, inception, clamped,
            portfolioReturn, benchmarkReturn,
            startNav, actualNav, passiveNav, passiveTax, depositsInPeriod,
            taxYears, taxSummary, taxInPeriod,
            selfEmployed, selfEmployedAlt, flatTaxBroken, investmentBase,
            navGrossEnd, regimeCost, tradingFinal, regimeKnown, flatTaxYear, benchmarkMeta,
            passiveDividendIncome, passiveBreaksFlatTax, passiveRegimeCost, passiveFinal, verdict,
            displayCurrency: currency === 'USD' ? 'USD' : merged.currency,
            baseCurrency: merged.currency,
            flowCount: merged.flows.length,
        };
    }, [merged, benchmark, benchmarkSymbol, currency, range, afterTax, rateMode, otherTaxBase,
        businessIncome, expenseMode, expenseRate, actualExpenses, flatTaxRegime, flatTaxMonthly, liquidate]);

    const isLoading = loadingIds.size > 0;
    const activeError = activeId === 'all' ? Object.values(errors)[0] : errors[activeId];

    // ── prázdný stav ──
    if (accounts.length === 0) {
        return (
            <div className="app">
                <header className="dashboard-header">
                    <h1 style={{ margin: 0 }}>Výkonnost vs. S&P 500</h1>
                </header>
                <div className="content-container">
                    <div className="card">
                        <p style={{ margin: 0 }}>
                            Nejdřív přidej účet na <a href="/" style={{ color: PORTFOLIO_COLOR }}>hlavní stránce</a>.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="app">
            <header className="dashboard-header">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', rowGap: '0.5rem' }}>
                    <h1 style={{ margin: 0 }}>Výkonnost vs. S&P 500</h1>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {accounts.length > 1 && (
                            <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => setActiveId('all')} style={tabStyle(activeId === 'all')}>Vše</button>
                                {accounts.map(a => (
                                    <button key={a.id} onClick={() => setActiveId(a.id)} style={tabStyle(activeId === a.id)}>
                                        {loadingIds.has(a.id) ? '⟳ ' : ''}{a.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <button
                            onClick={() => accounts.forEach(a => fetchSeries(a, true))}
                            style={tabStyle(false)}
                            disabled={isLoading}
                            title="Načíst čerstvá data z IBKR"
                        >
                            {isLoading ? '⟳ Načítám…' : '⟳ Obnovit'}
                        </button>
                    </div>
                </div>
            </header>

            <div className="content-container">
                {activeError && (
                    <div className="card" style={{ borderLeft: '4px solid var(--danger-color)', marginBottom: '1rem' }}>
                        <h3 style={{ color: 'var(--danger-color)', marginTop: 0 }}>Chyba</h3>
                        <p style={{ margin: 0 }}>{activeError}</p>
                    </div>
                )}

                {isLoading && !view && (
                    <div style={{ textAlign: 'center', opacity: 0.5, padding: '3rem 0' }}>
                        Načítám roční historii z IBKR… (první načtení trvá ~10 s)
                    </div>
                )}

                {view && (
                    <>
                        {/* ── ovládání ── */}
                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {RANGES.map(r => (
                                    <button key={r.key} onClick={() => setRange(r.key)} style={tabStyle(range === r.key)}>
                                        {r.label}
                                    </button>
                                ))}
                            </div>
                            <select
                                value={benchmarkSymbol}
                                onChange={e => setBenchmarkSymbol(e.target.value)}
                                style={{ ...inputStyle, width: 'auto', marginLeft: 'auto' }}
                                title="Proti čemu se portfolio porovnává"
                            >
                                {BENCHMARKS.map(b => (
                                    <option key={b.symbol} value={b.symbol}>{b.label}</option>
                                ))}
                            </select>

                            <div style={{ display: 'flex', gap: '4px' }}>
                                {(['CZK', 'USD'] as Currency[]).map(c => (
                                    <button key={c} onClick={() => setCurrency(c)} style={tabStyle(currency === c)}>
                                        {c}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* ── daně ── */}
                        <div style={{
                            display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center',
                            marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: 'var(--border-radius)',
                            background: afterTax ? 'rgba(248,113,113,0.08)' : 'var(--card-bg)',
                            border: `1px solid ${afterTax ? 'rgba(248,113,113,0.4)' : '#334155'}`,
                        }}>
                            <button onClick={() => setAfterTax(v => !v)} style={{ ...tabStyle(afterTax), padding: '6px 14px' }}>
                                {afterTax ? '☑' : '☐'} Započítat daně
                            </button>

                            {afterTax && (
                                <>
                                    <label style={labelStyle}>
                                        Paušální daň
                                        <input
                                            type="number"
                                            value={flatTaxMonthly || ''}
                                            onChange={e => setFlatTaxMonthly(Number(e.target.value) || 0)}
                                            style={{ ...inputStyle, width: '90px' }}
                                        />
                                        Kč/měsíc
                                    </label>

                                    <label style={labelStyle}>
                                        Roční obrat OSVČ
                                        <input
                                            type="number"
                                            value={businessIncome || ''}
                                            onChange={e => setBusinessIncome(Number(e.target.value) || 0)}
                                            placeholder="např. 900000"
                                            style={inputStyle}
                                        />
                                        Kč, výdaje
                                        <select
                                            value={expenseMode === 'actual' ? 'actual' : String(expenseRate)}
                                            onChange={e => {
                                                if (e.target.value === 'actual') setExpenseMode('actual');
                                                else { setExpenseMode('lump'); setExpenseRate(Number(e.target.value)); }
                                            }}
                                            style={{ ...inputStyle, width: 'auto' }}
                                        >
                                            {[0.8, 0.6, 0.4, 0.3].map(r => (
                                                <option key={r} value={r}>paušál {Math.round(r * 100)} %</option>
                                            ))}
                                            <option value="actual">skutečné</option>
                                        </select>
                                        {expenseMode === 'actual' && (
                                            <input
                                                type="number"
                                                value={actualExpenses || ''}
                                                onChange={e => setActualExpenses(Number(e.target.value) || 0)}
                                                placeholder="výdaje v Kč"
                                                style={inputStyle}
                                            />
                                        )}
                                    </label>

                                    <button onClick={() => setLiquidate(v => !v)} style={tabStyle(liquidate)}>
                                        {liquidate ? '☑' : '☐'} Prodat dnes všechno
                                    </button>

                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', flexBasis: '100%', lineHeight: 1.6 }}>
                                        {businessIncome > 0 ? (
                                            <>Dílčí základ §7 <strong style={{ color: 'var(--text-primary)' }}>{fmtMoney(otherTaxBase, 'CZK')}</strong>,
                                                {' '}zisky z obchodování se daní sazbou{' '}
                                                <strong style={{ color: 'var(--text-primary)' }}>{(view.taxSummary.rate * 100).toFixed(0)} %</strong>.
                                                {' '}Sazba 23 % se vztahuje na součet všech dílčích základů, ne na investice zvlášť —
                                                základ z podnikání proto zaplní pásmo pod hranicí {fmtMoney(DEFAULT_TAX_SETTINGS.progressiveThreshold, 'CZK')} dřív
                                                než trading.</>
                                        ) : (
                                            <strong style={{ color: 'var(--danger-color)' }}>
                                                Vyplň roční obrat, jinak nejde spočítat, co tě stojí ztráta paušálního režimu.
                                            </strong>
                                        )}
                                        {' '}Příjmy z §8 a §10 nevstupují do sociálního ani zdravotního pojištění, takže
                                        odvody OSVČ trading nezvyšuje.
                                    </span>
                                </>
                            )}
                        </div>

                        {/* ── verdikt ── */}
                        <Verdict view={view} afterTax={afterTax} />

                        {/* ── souhrn ── */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                            <div className="card summary-card">
                                <h3>Moje portfolio</h3>
                                <div className="value" style={{ color: view.portfolioReturn >= 0 ? 'var(--success-color)' : 'var(--danger-color)' }}>
                                    {fmtPct(view.portfolioReturn)}
                                </div>
                                <div className="subtext">
                                    TWR, očištěno o vklady{afterTax && ' · po zdanění'}
                                </div>
                            </div>

                            <div className="card summary-card">
                                <h3>{view.benchmarkMeta.short}</h3>
                                <div className="value" style={{ color: BENCHMARK_COLOR }}>
                                    {view.benchmarkReturn === null ? '—' : fmtPct(view.benchmarkReturn)}
                                </div>
                                <div className="subtext">
                                    {view.benchmarkMeta.distributing
                                        ? (afterTax ? 'po dani z dividend' : 'vč. dividend')
                                        : 'bez výplat dividend'}, v {view.displayCurrency}
                                </div>
                            </div>

                            <div className="card summary-card">
                                <h3>Rozdíl</h3>
                                <div className="value" style={{
                                    color: view.benchmarkReturn === null ? 'var(--text-secondary)'
                                        : view.portfolioReturn >= view.benchmarkReturn ? 'var(--success-color)' : 'var(--danger-color)',
                                }}>
                                    {view.benchmarkReturn === null ? '—' : fmtPct(view.portfolioReturn - view.benchmarkReturn) + ' b.'}
                                </div>
                                <div className="subtext">
                                    {view.benchmarkReturn === null ? 'benchmark nedostupný'
                                        : view.portfolioReturn >= view.benchmarkReturn ? 'aktivní trading vede' : 'index vede'}
                                </div>
                            </div>

                            <div className="card summary-card">
                                <h3>Rozdíl v penězích</h3>
                                <div className="value" style={{
                                    fontSize: '1.5rem',
                                    color: Number.isFinite(view.verdict)
                                        ? (view.verdict >= 0 ? 'var(--success-color)' : 'var(--danger-color)')
                                        : 'var(--text-secondary)',
                                }}>
                                    {Number.isFinite(view.verdict)
                                        ? (view.verdict >= 0 ? '+' : '') + fmtMoney(view.verdict, view.displayCurrency)
                                        : '—'}
                                </div>
                                <div className="subtext">
                                    proti stejným vkladům do SPY{afterTax && ', po všech daních'}
                                </div>
                            </div>
                        </div>

                        {/* ── graf ── */}
                        <div className="card" style={{ padding: '1rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <h3 style={{ margin: 0 }}>Kumulativní výnos od {fmtDate(view.startDate)}</h3>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                    k {fmtDate(view.lastDate)} · {view.displayCurrency}
                                </span>
                            </div>

                            <div style={{ width: '100%', height: 380 }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={view.rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                        <XAxis
                                            dataKey="date"
                                            tickFormatter={fmtDateShort}
                                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                                            minTickGap={40}
                                            stroke="#334155"
                                        />
                                        <YAxis
                                            tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %`}
                                            tick={{ fill: '#94a3b8', fontSize: 11 }}
                                            stroke="#334155"
                                            width={58}
                                        />
                                        <ReferenceLine y={0} stroke="#475569" />
                                        <Tooltip
                                            labelFormatter={(l: any) => fmtDate(String(l))}
                                            formatter={(v: any, name: any) => [v === null ? '—' : fmtPct(Number(v)), name]}
                                            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                                            itemStyle={{ color: '#f1f5f9' }}
                                        />
                                        <Legend wrapperStyle={{ fontSize: '0.8rem' }} />
                                        <Line
                                            type="monotone" dataKey="portfolio" name="Moje portfolio"
                                            stroke={PORTFOLIO_COLOR} strokeWidth={2} dot={false} isAnimationActive={false}
                                        />
                                        <Line
                                            type="monotone" dataKey="benchmark" name={view.benchmarkMeta.short}
                                            stroke={BENCHMARK_COLOR} strokeWidth={2} dot={false} isAnimationActive={false}
                                            connectNulls
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* ── detaily ── */}
                        <details className="card" style={{ marginTop: '1rem' }}>
                            <summary style={summaryStyle}>Jak se to počítá</summary>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                <tbody>
                                    <Row label={`Hodnota účtu k ${fmtDate(view.startDate)}`} value={fmtMoney(view.startNav, view.displayCurrency)} />
                                    <Row label="Vklady/výběry za období" value={fmtMoney(view.depositsInPeriod, view.displayCurrency)} />
                                    <Row label="Hodnota účtu dnes" value={fmtMoney(view.navGrossEnd, view.displayCurrency)} highlight={PORTFOLIO_COLOR} />
                                </tbody>
                            </table>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0, marginTop: '1rem', lineHeight: 1.6 }}>
                                Procenta v kartách nahoře jsou <strong>TWR</strong> (time-weighted return) — řetězené denní
                                výnosy, z nichž je odečten vklad či výběr daného dne. Měří kvalitu obchodování bez ohledu
                                na to, kdy jsi peníze poslal, a je proto přímo srovnatelný s indexem. Verdikt v koruně
                                nahoře naopak počítá s reálným načasováním tvých peněz: každý vklad „nakoupí“ SPY za kurz
                                toho dne. Proto se může stát, že v procentech vedeš a v korunách ne — když ti nejlepší
                                výsledky přišly v době, kdy jsi na účtu měl málo peněz.
                                {view.flowCount > 0 && ` Za období bylo detekováno ${view.flowCount} pohybů peněz.`}
                                {currency === 'CZK'
                                    ? ' V režimu CZK je S&P 500 přepočtený denním kurzem IBKR, takže zahrnuje i pohyb USD/CZK — tedy to, co bys reálně vydělal jako korunový investor.'
                                    : ' V režimu USD je i tvoje NAV přepočtená na dolary, takže měnový pohyb je z obou stran odstraněný.'}
                            </p>
                        </details>

                        {afterTax && view.regimeKnown && view.flatTaxBroken && (
                            <details className="card" style={{ marginTop: '1rem', borderLeft: '4px solid var(--danger-color)' }}>
                                <summary style={{ ...summaryStyle, color: 'var(--danger-color)' }}>
                                    Trading tě vyřadil z paušálního režimu — detailní výpočet
                                </summary>
                                <p style={{ fontSize: '0.85rem', lineHeight: 1.7, marginTop: 0 }}>
                                    Za rok máš <strong>{fmtMoney(view.taxSummary.grossIncome, view.baseCurrency)}</strong> příjmů
                                    z §8 a §10, limit je {fmtMoney(FLAT_TAX_INCOME_LIMIT, 'CZK')}. Pozor na to, že u prodeje
                                    cenných papírů se do limitu počítá <strong>hrubý příjem z prodeje, ne zisk</strong> — proto
                                    je překročení tak výrazné. Za tenhle rok tedy podáváš běžné daňové přiznání a k němu
                                    přehledy na OSSZ a zdravotní pojišťovnu. Zaplacené paušální zálohy se neztratí, započtou
                                    se (daňová část na daň, pojistné části na pojistné).
                                </p>

                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                    <tbody>
                                        <Row label="Dílčí základ §7 (podnikání)" value={fmtMoney(view.selfEmployed.base7, 'CZK')} />
                                        <Row label="Základ z investic" value={fmtMoney(view.investmentBase, 'CZK')} />
                                        <Row label="Daň z příjmů po slevě na poplatníka" value={fmtMoney(view.selfEmployed.incomeTax, 'CZK')} />
                                        <Row label="Sociální pojištění (29,2 % z ½ základu)" value={fmtMoney(view.selfEmployed.social, 'CZK')} />
                                        <Row label="Zdravotní pojištění (13,5 % z ½ základu)" value={fmtMoney(view.selfEmployed.health, 'CZK')} />
                                        <Row label="Celkem v běžném režimu" value={fmtMoney(view.selfEmployed.totalDue, 'CZK')} highlight="var(--text-primary)" />
                                        <Row label="− zaplacená paušální daň" value={fmtMoney(-view.flatTaxYear, 'CZK')} highlight="var(--success-color)" />
                                        <Row
                                            label="Celková cena tradingu na daních a odvodech"
                                            value={fmtMoney(view.selfEmployed.totalTradingCost, 'CZK')}
                                            highlight="var(--danger-color)"
                                        />
                                    </tbody>
                                </table>

                                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 0 }}>
                                    Z toho <strong>{fmtMoney(view.selfEmployed.investmentTaxAlone, 'CZK')}</strong> je daň
                                    ze samotných zisků a <strong>{fmtMoney(view.selfEmployed.regimeChangeCost, 'CZK')}</strong> je
                                    to, co navíc stojí ztráta paušálu.
                                    {businessIncome > 0 && (
                                        <> Se {expenseMode === 'lump' ? 'skutečnými výdaji' : `výdajovým paušálem ${Math.round(expenseRate * 100)} %`} by
                                            celkem vyšlo {fmtMoney(view.selfEmployedAlt.totalDue, 'CZK')}, tedy
                                            {' '}{view.selfEmployedAlt.totalDue < view.selfEmployed.totalDue ? 'méně' : 'více'} o
                                            {' '}{fmtMoney(Math.abs(view.selfEmployedAlt.totalDue - view.selfEmployed.totalDue), 'CZK')}.</>
                                    )}
                                    {' '}Pozor: u nízkého základu se uplatní minimální vyměřovací základy a odvody pak vyjdou
                                    vyšší, než počítá tenhle odhad. Sazby pojistného, slevu na poplatníka i hranici progrese
                                    si ověř pro daný rok — a tohle rozhodnutí probírej s daňařem, ne s dashboardem.
                                </p>
                            </details>
                        )}

                        {afterTax && (
                            <details className="card" style={{ marginTop: '1rem' }}>
                                <summary style={summaryStyle}>Z čeho se daň skládá</summary>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #475569' }}>
                                            <th style={thStyle}>Druh příjmu</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Základ</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Osvobozeno</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Daň</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {([
                                            ['securities', 'Akcie a fondy (§10)'],
                                            ['derivatives', 'Opce a futures (§10)'],
                                            ['crypto', 'Krypto (§10)'],
                                            ['other', 'Ostatní (§10)'],
                                        ] as const)
                                            .filter(([k]) => view.taxSummary.taxableByBucket[k] || view.taxSummary.exemptByBucket[k] || view.taxSummary.taxByBucket[k])
                                            .map(([k, label]) => (
                                                <tr key={k} style={{ borderBottom: '1px solid #334155' }}>
                                                    <td style={tdStyle}>{label}</td>
                                                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(view.taxSummary.taxableByBucket[k], view.baseCurrency)}</td>
                                                    <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--success-color)' }}>
                                                        {view.taxSummary.exemptByBucket[k] ? fmtMoney(view.taxSummary.exemptByBucket[k], view.baseCurrency) : '—'}
                                                    </td>
                                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(view.taxSummary.taxByBucket[k], view.baseCurrency)}</td>
                                                </tr>
                                            ))}
                                        {view.taxSummary.dividendGross !== 0 && (
                                            <tr style={{ borderBottom: '1px solid #334155' }}>
                                                <td style={tdStyle}>Dividendy (§8)</td>
                                                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(view.taxSummary.dividendGross, view.baseCurrency)}</td>
                                                <td style={{ ...tdStyle, textAlign: 'right' }}>—</td>
                                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(view.taxSummary.dividendTax, view.baseCurrency)}</td>
                                            </tr>
                                        )}
                                        {view.taxSummary.interestGross !== 0 && (
                                            <tr style={{ borderBottom: '1px solid #334155' }}>
                                                <td style={tdStyle}>Úroky (§8)</td>
                                                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(view.taxSummary.interestGross, view.baseCurrency)}</td>
                                                <td style={{ ...tdStyle, textAlign: 'right' }}>—</td>
                                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{fmtMoney(view.taxSummary.interestTax, view.baseCurrency)}</td>
                                            </tr>
                                        )}
                                        <tr style={{ borderTop: '2px solid #475569' }}>
                                            <td style={{ ...tdStyle, fontWeight: 700 }}>Celkem</td>
                                            <td style={tdStyle}></td>
                                            <td style={{ ...tdStyle, textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                {view.taxSummary.withheld > 0 && `zápočet ${fmtMoney(view.taxSummary.withheld, view.baseCurrency)}`}
                                            </td>
                                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--danger-color)' }}>
                                                {fmtMoney(view.taxSummary.total, view.baseCurrency)}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>

                                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0, marginTop: '1rem', lineHeight: 1.6 }}>
                                    <strong>Tohle je odhad, ne daňové přiznání.</strong> Model počítá s tím, že akcie
                                    prodané po 3 letech jsou osvobozené a že osvobozený je i rok, kdy úhrn hrubých
                                    prodejů cenných papírů nepřesáhne 100 000 Kč. Opce a futures žádný takový test
                                    nemají — daní se vždy, a právě to je hlavní důvod, proč aktivní trading musí index
                                    porazit o víc než jen o pár desetin procenta. Ztráta v jednom druhu příjmu se
                                    nepřenáší proti jinému druhu ani do dalších let, proto se každý řádek ořezává na nulu.
                                    Sražená zahraniční daň se započítává jen do výše české daně z téhož příjmu.
                                    {view.taxSummary.interestPaid > 0 && (
                                        <> Zaplacené debetní úroky {fmtMoney(view.taxSummary.interestPaid, view.baseCurrency)} základ
                                            nesnižují — u §8 si fyzická osoba výdaje uplatnit nemůže.</>
                                    )}
                                    {view.taxSummary.unknownHoldingPnl > 0 && (
                                        <> U zisku {fmtMoney(view.taxSummary.unknownHoldingPnl, view.baseCurrency)} se
                                            nepodařilo dohledat dobu držení (pozice otevřená před začátkem staženého
                                            období), počítá se proto jako zdanitelný.</>
                                    )}
                                    {' '}Daň se počítá vždy za celý kalendářní rok, ne za vybraný rozsah grafu.
                                </p>
                            </details>
                        )}

                        {(view.clamped || range === 'MAX') && (
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>
                                Srovnání začíná {fmtDate(view.startDate)}
                                {view.startDate === view.inception && ' — od té doby má účet dost prostředků na to, aby byl denní výnos smysluplný. Dřívější období s téměř prázdným účtem by procenta rozbilo.'}
                            </p>
                        )}

                        {benchmarkError && (
                            <p style={{ fontSize: '0.75rem', color: 'var(--danger-color)', marginTop: '0.5rem' }}>
                                Benchmark se nepodařilo načíst: {benchmarkError}
                            </p>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * Jediné číslo, na které se člověk ptá: kolik mi na konci zbyde proti tomu,
 * kdybych nic nedělal a jen držel index. Obě strany nesou úplně všechny své
 * náklady, aby se daly porovnat přímo.
 */
function Verdict({ view, afterTax }: { view: any; afterTax: boolean }) {
    const cur = view.displayCurrency;
    const wins = view.verdict >= 0;
    const known = Number.isFinite(view.verdict);
    const color = !known ? 'var(--text-secondary)' : wins ? 'var(--success-color)' : 'var(--danger-color)';

    return (
        <div className="card" style={{ marginBottom: '1rem', borderLeft: `4px solid ${color}`, padding: '1.25rem 1.5rem' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.25rem' }}>
                Vyplatil se ti trading od {fmtDate(view.startDate)}?
            </h3>

            <div style={{ fontSize: '2.4rem', fontWeight: 700, color, lineHeight: 1.2 }}>
                {known ? (wins ? '+' : '') + fmtMoney(view.verdict, cur) : '—'}
            </div>

            <p style={{ fontSize: '0.95rem', margin: '0.25rem 0 1.25rem', color: 'var(--text-secondary)' }}>
                {!known ? 'Benchmark se nepodařilo načíst.' : wins
                    ? <>Ano. Aktivním obchodováním máš o tolik <strong style={{ color: 'var(--success-color)' }}>víc</strong>, než kdybys stejné peníze ve stejné dny poslal do S&P 500{afterTax && ' — po zaplacení všech daní a odvodů'}.</>
                    : <>Ne. Aktivní obchodování tě zatím stálo o tolik <strong style={{ color: 'var(--danger-color)' }}>víc</strong>, než kdybys stejné peníze ve stejné dny poslal do S&P 500 a nedělal nic{afterTax && ' — po zaplacení všech daní a odvodů'}.</>}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
                {/* levý sloupec: trading */}
                <div>
                    <div style={{ ...colTitleStyle, color: PORTFOLIO_COLOR }}>Co máš díky tradingu</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <tbody>
                            <Row label="Hodnota účtu dnes" value={fmtMoney(view.navGrossEnd, cur)} />
                            {afterTax && (
                                <Row label="− daň ze zisků z obchodování" value={fmtMoney(-view.taxInPeriod, cur)} highlight="var(--danger-color)" />
                            )}
                            {afterTax && view.regimeCost !== 0 && (
                                <Row label="− ztráta paušálního režimu" value={fmtMoney(-view.regimeCost, cur)} highlight="var(--danger-color)" />
                            )}
                            <Row label="Zůstane ti" value={fmtMoney(view.tradingFinal, cur)} highlight={PORTFOLIO_COLOR} />
                        </tbody>
                    </table>
                </div>

                {/* pravý sloupec: index */}
                <div>
                    <div style={{ ...colTitleStyle, color: BENCHMARK_COLOR }}>Co bys měl při držení {view.benchmarkMeta.short}</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <tbody>
                            <Row
                                label="Hodnota při stejných vkladech"
                                value={Number.isFinite(view.passiveNav) ? fmtMoney(view.passiveNav + view.passiveTax, cur) : '—'}
                            />
                            {afterTax && view.passiveTax > 0 && (
                                <Row label="− daň při prodeji indexu" value={fmtMoney(-view.passiveTax, cur)} highlight="var(--danger-color)" />
                            )}
                            {afterTax && view.passiveRegimeCost !== 0 && (
                                <Row label="− ztráta paušálního režimu" value={fmtMoney(-view.passiveRegimeCost, cur)} highlight="var(--danger-color)" />
                            )}
                            <Row
                                label="Zůstalo by ti"
                                value={Number.isFinite(view.passiveFinal) ? fmtMoney(view.passiveFinal, cur) : '—'}
                                highlight={BENCHMARK_COLOR}
                            />
                        </tbody>
                    </table>
                </div>
            </div>

            {afterTax && (
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '1rem 0 0', lineHeight: 1.7 }}>
                    Daň z dividend indexu je už započítaná v jeho hodnotě, proto tam není zvlášť.
                    {view.passiveRegimeCost === 0 && view.regimeCost !== 0 && (
                        <> Držení indexu by ti paušální režim <strong>zachovalo</strong>: vyplatilo by na dividendách
                            zhruba {fmtMoney(view.passiveDividendIncome, cur)}, což je pod limitem
                            {' '}{fmtMoney(FLAT_TAX_INCOME_LIMIT, 'CZK')}. Tvůj trading naopak limit překročil,
                            a tenhle rozdíl je v porovnání ta největší jednotlivá položka.</>
                    )}
                    {view.regimeCost < 0 && (
                        <> Ztráta paušálu ti tady vychází jako <strong>úspora</strong> — běžný režim je při tvém
                            obratu levnější než paušální daň, takže je v tabulce se záporným znaménkem.</>
                    )}
                </p>
            )}
        </div>
    );
}

const colTitleStyle: React.CSSProperties = {
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 700,
    marginBottom: '0.5rem',
};

function Row({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
    return (
        <tr style={{ borderBottom: '1px solid #334155' }}>
            <td style={{ padding: '0.55rem 0', color: 'var(--text-secondary)' }}>{label}</td>
            <td style={{ padding: '0.55rem 0', textAlign: 'right', fontWeight: 600, color: highlight ?? 'var(--text-primary)' }}>
                {value}
            </td>
        </tr>
    );
}

const thStyle: React.CSSProperties = {
    padding: '0.5rem 0',
    textAlign: 'left',
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-secondary)',
    fontWeight: 600,
};

const tdStyle: React.CSSProperties = { padding: '0.5rem 0' };

const summaryStyle: React.CSSProperties = {
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-secondary)',
    marginBottom: '0.75rem',
};

const labelStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    fontSize: '0.78rem',
    color: 'var(--text-secondary)',
};

const inputStyle: React.CSSProperties = {
    width: '130px',
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#f1f5f9',
    fontSize: '0.78rem',
};

function tabStyle(active: boolean): React.CSSProperties {
    return {
        fontSize: '0.78rem',
        fontWeight: active ? 700 : 500,
        padding: '4px 12px',
        borderRadius: '6px',
        border: active ? '1px solid #3b82f6' : '1px solid #334155',
        background: active ? '#1e40af' : '#1e293b',
        color: active ? '#fff' : '#94a3b8',
        cursor: 'pointer',
    };
}
