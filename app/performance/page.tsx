'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { Account } from '../types';
import { mergeNavSeries } from '../lib/twr';
import { mergeCashBalances, sumByDate } from '../lib/cash';
import { computePersonalComparison, type PersonalBenchmark, type PersonalSeries } from '../lib/personalComparison';

interface PerformanceSeries extends PersonalSeries { accountIds: string[] }
const PORTFOLIO_COLOR = '#38bdf8';
const BENCHMARK_COLOR = '#f59e0b';
const GAP_COLOR = '#a78bfa';
const LS_ACCOUNTS = 'ibkr_accounts';
const LS_PROFILE = 'ibkr_personal_performance';
const fmtDate = (date: string) => `${date.slice(6, 8)}.${date.slice(4, 6)}.${date.slice(0, 4)}`;
const fmtDateShort = (date: string) => `${+date.slice(6, 8)}.${+date.slice(4, 6)}.`;
const money = (amount: number) => Number.isFinite(amount) ? `${(Math.round(amount) || 0).toLocaleString('cs-CZ')} Kč` : '—';
const signedMoney = (amount: number) => Number.isFinite(amount) ? `${Math.round(amount) > 0 ? '+' : ''}${money(amount)}` : '—';
const percent = (amount: number) => Number.isFinite(amount) ? `${amount > 0 ? '+' : ''}${amount.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} %` : '—';
const pct = (fraction: number) => percent(fraction * 100);
const plainPct = (fraction: number) => Number.isFinite(fraction) ? `${(fraction * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %` : '—';
const fxRate = (rate: number) => rate.toLocaleString('cs-CZ', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const usd = (amount: number) => `${amount.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
const thousands = (amount: number) => `${Math.round(amount / 1000).toLocaleString('cs-CZ')} tis.`;
const tone = (amount: number) => Math.round(amount) > 0 ? 'var(--success-color)' : Math.round(amount) < 0 ? 'var(--danger-color)' : undefined;

function mergeSeries(list: PerformanceSeries[]): PerformanceSeries | null {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];

    const combined = mergeNavSeries(list);
    return {
        ...combined,
        warnings: [...new Set(list.flatMap(s => s.warnings ?? []))],
        cashByCurrency: mergeCashBalances(list.map(s => s.cashByCurrency)),
        nonCashByDate: sumByDate(list.map(s => s.nonCashByDate), combined.nav.map(n => n.date)),
        // Daňové vstupy se slučují prostým spojením — základ daně je jeden
        // za poplatníka, ne za účet.
        tax: {
            trades: list.flatMap(s => s.tax.trades).filter(item => item.date <= combined.toDate),
            // Preserve snapshot dates: the liquidation model must detect an
            // incompatible valuation instead of silently dropping positions.
            unrealized: list.flatMap(s => s.tax.unrealized),
            dividends: list.flatMap(s => s.tax.dividends).filter(item => item.date <= combined.toDate),
            dividendWithheld: list.flatMap(s => s.tax.dividendWithheld).filter(item => item.date <= combined.toDate),
            interest: list.flatMap(s => s.tax.interest).filter(item => item.date <= combined.toDate),
            interestWithheld: list.flatMap(s => s.tax.interestWithheld).filter(item => item.date <= combined.toDate),
        },
    };
}

export default function PerformancePage() {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [activeId, setActiveId] = useState('all');
    const [series, setSeries] = useState<Record<string, PerformanceSeries>>({});
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [benchmark, setBenchmark] = useState<PersonalBenchmark | null>(null);
    const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
    const [businessIncome, setBusinessIncome] = useState(1_200_000);
    const [hydrated, setHydrated] = useState(false);
    const pending = useRef(new Set<string>());

    async function fetchSeries(account: Account, force = false) {
        if (pending.current.has(account.id)) return;
        pending.current.add(account.id);
        setLoadingIds(previous => new Set(previous).add(account.id));
        setErrors(previous => { const next = { ...previous }; delete next[account.id]; return next; });
        try {
            const response = await fetch(`/api/performance${force ? '?force=1' : ''}`, {
                headers: { 'x-flex-token': account.token, 'x-flex-query-id': account.queryId },
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Nepodařilo se načíst výpis.');
            setSeries(previous => ({ ...previous, [account.id]: data }));
        } catch (error) {
            setSeries(previous => { const next = { ...previous }; delete next[account.id]; return next; });
            setErrors(previous => ({ ...previous, [account.id]: error instanceof Error ? error.message : 'Chyba načítání.' }));
        } finally {
            pending.current.delete(account.id);
            setLoadingIds(previous => { const next = new Set(previous); next.delete(account.id); return next; });
        }
    }

    useEffect(() => {
        try {
            const saved: Account[] = JSON.parse(localStorage.getItem(LS_ACCOUNTS) || '[]');
            if (Array.isArray(saved)) {
                setAccounts(saved);
                setActiveId(saved.length === 1 ? saved[0].id : 'all');
                saved.forEach(account => { void fetchSeries(account); });
            }
            // Old tax/scenario switches intentionally cannot change this fixed overview.
            const profile = JSON.parse(localStorage.getItem(LS_PROFILE) || '{}');
            if (Number.isFinite(profile.businessIncome) && profile.businessIncome >= 0) setBusinessIncome(profile.businessIncome);
        } catch { /* confirmed personal profile remains the default */ }
        setHydrated(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!hydrated) return;
        try { localStorage.setItem(LS_PROFILE, JSON.stringify({ businessIncome })); } catch { /* unavailable storage */ }
    }, [businessIncome, hydrated]);

    const mergeResult = useMemo(() => {
        const ids = activeId === 'all' ? accounts.map(account => account.id) : [activeId];
        if (!ids.length || ids.some(id => !series[id] || loadingIds.has(id) || errors[id])) return { data: null, error: null };
        try { return { data: mergeSeries(ids.map(id => series[id])), error: null }; }
        catch (error) { return { data: null, error: error instanceof Error ? error.message : 'Výpisy nelze spojit.' }; }
    }, [accounts, activeId, series, loadingIds, errors]);
    const merged = mergeResult.data;
    const benchmarkFrom = merged?.fromDate;
    const benchmarkTo = merged?.toDate;

    useEffect(() => {
        setBenchmark(null);
        setBenchmarkError(null);
        if (!benchmarkFrom || !benchmarkTo) return;
        const controller = new AbortController();
        fetch(`/api/benchmark?symbol=SPY&from=${benchmarkFrom}&to=${benchmarkTo}`, { signal: controller.signal })
            .then(async response => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Nepodařilo se načíst index.');
                if (!controller.signal.aborted) setBenchmark(data);
            })
            .catch(error => { if (!controller.signal.aborted) setBenchmarkError(error.message); });
        return () => controller.abort();
    }, [benchmarkFrom, benchmarkTo]);

    const calculation = useMemo(() => {
        if (!merged || !benchmark || benchmark.from !== merged.fromDate || benchmark.to !== merged.toDate) return { view: null, error: null };
        try { return { view: computePersonalComparison(merged, benchmark, businessIncome), error: null }; }
        catch (error) { return { view: null, error: error instanceof Error ? error.message : 'Chyba výpočtu.' }; }
    }, [merged, benchmark, businessIncome]);
    const view = calculation.view;
    const error = mergeResult.error || (activeId === 'all' ? Object.values(errors)[0] : errors[activeId]) || benchmarkError || calculation.error;
    const loading = loadingIds.size > 0;

    return <div className="app">
        <header className="dashboard-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <h1 style={{ margin: 0 }}>Vyplatil se mi letos trading?</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {accounts.length > 1 && <select aria-label="Účet" value={activeId} onChange={event => setActiveId(event.target.value)} style={inputStyle}>
                    <option value="all">Všechny účty</option>
                    {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>}
                {accounts.length > 0 && <button style={buttonStyle} disabled={loading} onClick={() => accounts.forEach(account => { void fetchSeries(account, true); })}>
                    {loading ? 'Načítám…' : 'Obnovit data'}
                </button>}
            </div>
        </header>
        <div className="content-container">
            {hydrated && !accounts.length && <div className="card">Nejdřív přidej účet na <Link href="/" style={{ color: PORTFOLIO_COLOR }}>hlavní stránce</Link>.</div>}
            {error && <div className="card" role="alert" style={{ borderLeft: '4px solid var(--danger-color)' }}>
                <h3>Srovnání se nepodařilo spočítat</h3><p>{error}</p>
            </div>}
            {accounts.length > 0 && !view && !error && <div className="card" role="status">Načítám výpis a porovnávám ho s indexem…</div>}
            {view && <ComparisonView view={view} warnings={[...new Set([...(merged?.warnings ?? []), ...view.result.warnings])]} />}
            {accounts.length > 0 && <details className="card" style={{ marginTop: 16 }}>
                <summary style={summaryStyle}>Moje údaje</summary>
                <p>Vývojář na českou živnost, hlavní činnost celý rok, výdajový paušál 60 %, první pásmo paušální daně před tradingem a základní sleva na poplatníka. Podle tvého zadání jsou skutečné výdaje zanedbatelné.</p>
                <label style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                    Roční příjem z podnikání
                    <input type="number" aria-label="Roční příjem z podnikání" min="0" max="1500000" value={businessIncome} onChange={event => setBusinessIncome(Math.max(0, Number(event.target.value) || 0))} style={inputStyle} /> Kč
                </label>
                <p className="subtext">Výsledek předpokládá, že jiné příjmy ani okolnosti by samy o sobě paušální režim nevyloučily. Zvolená daňová varianta je nejvýhodnější z těch, které model umí doložit dostupnými údaji.</p>
            </details>}
        </div>
    </div>;
}

type Comparison = ReturnType<typeof computePersonalComparison>;

function ComparisonView({ view, warnings }: { view: Comparison; warnings: string[] }) {
    const { result, index, tradingSources: src, taxDetail } = view;
    const grossGap = result.trading.gross - result.passive.gross;
    const opening = `Hodnota k ${fmtDate(view.startDate)}`;
    const recent = view.gapRows.slice(-5);
    const recentMin = Math.min(...recent.map(row => row.gross));
    const recentMax = Math.max(...recent.map(row => row.gross));
    const usdCash = view.cash?.find(row => row.currency === 'USD');
    const trading = taxDetail?.trading;
    const lostBasket = (gain: number) => gain < 0 ? 'ztráta — nezdaňuje se a model ji nezapočítává proti jiným druhům obchodů' : undefined;

    return <>
        <p className="subtext">Rok {view.year} · data k {fmtDate(view.lastDate)} · stejné vklady a výběry · vše v Kč</p>
        {index.staleDates.length > 0 && <div className="card" role="alert" style={{ borderLeft: '4px solid #f59e0b' }}>
            <strong>Chybí cena SPY k {index.staleDates.map(row => fmtDate(row.date)).join(', ')}.</strong>{' '}
            Použila se starší cena ({index.staleDates.map(row => `za ${fmtDate(row.date)} cena z ${fmtDate(row.priceDate)}`).join(', ')}) s kurzem z daného dne, takže výsledek může být posunutý. Zkus data obnovit za pár minut.
        </div>}
        {index.filledFromIntraday.includes(view.lastDate) && <div className="card" role="status" style={{ borderLeft: '4px solid #f59e0b' }}>
            Yahoo zatím nemá závěrečnou cenu SPY k {fmtDate(view.lastDate)}. Index je oceněn poslední hodinovou cenou toho dne; po zveřejnění závěrečné ceny se výsledek může mírně posunout.
        </div>}
        <QuickVerdict view={view} />
        {view.partialYear && <p style={{ color: '#f59e0b' }}>Výpis začíná až {fmtDate(view.startDate)}. Výsledek pokrývá dostupnou část roku.</p>}

        <Section title="Odkud se rozdíl bere">
            <table style={tableStyle}><tbody>
                <Row label="Hrubý zisk tradingu (před českou daní)" value={signedMoney(view.grossGain.trading)} />
                <Row label="Hrubý zisk drženého indexu" value={signedMoney(view.grossGain.passive)} />
                <Row label="Rozdíl před daněmi" value={signedMoney(grossGap)} color={tone(grossGap)} strong />
                <Row label="Česká daň z investic u tradingu" hint="Daň z realizovaných obchodů, z uzavření otevřených pozic, z dividend a z úroků." value={signedMoney(-result.trading.investmentTax)} color={tone(-result.trading.investmentTax)} />
                <Row label="Ztráta paušálního režimu kvůli tradingu" hint="Běžný režim OSVČ (pojistné + daň z podnikání) minus paušální daň, kterou platíš tak jako tak." value={signedMoney(-result.trading.regimeCost)} color={tone(-result.trading.regimeCost)} />
                <Row label="Daň a paušál u indexu" hint="ETF se drží a neprodává; po 3 letech je prodej osvobozený a paušál zůstává." value={signedMoney(-result.passive.totalCost)} color={tone(-result.passive.totalCost)} />
                <Row label="Čistý rozdíl trading − index" value={signedMoney(result.delta)} color={tone(result.delta)} highlight />
            </tbody></table>
        </Section>

        <Section title="Trading vs. index vedle sebe">
            <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
                    <thead><tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                        <th style={{ textAlign: 'left', padding: '6px 0', fontWeight: 500 }}></th>
                        <th style={{ padding: '6px 0 6px 8px', fontWeight: 600, color: PORTFOLIO_COLOR }}>Trading</th>
                        <th style={{ padding: '6px 0 6px 8px', fontWeight: 600, color: BENCHMARK_COLOR }}>Index S&P 500</th>
                    </tr></thead>
                    <tbody>
                        <PairRow label={opening} a={money(view.initialValue)} b={money(view.initialValue)} />
                        <PairRow label="Vklady − výběry" a={signedMoney(view.netContributions)} b={signedMoney(view.netContributions)} />
                        <PairRow label="Hrubý zisk" a={signedMoney(view.grossGain.trading)} b={signedMoney(view.grossGain.passive)} />
                        <PairRow label={`Hodnota k ${fmtDate(view.lastDate)} před daní`} a={money(result.trading.gross)} b={money(result.passive.gross)} strong />
                        <PairRow label="Daň z investic" a={signedMoney(-result.trading.investmentTax)} b={signedMoney(-result.passive.investmentTax)} />
                        <PairRow label="Ztráta paušálu" a={signedMoney(-result.trading.regimeCost)} b={signedMoney(-result.passive.regimeCost)} />
                        <PairRow label="Čistá hodnota po daních" a={money(result.trading.net)} b={money(result.passive.net)} strong />
                        <PairRow label="Čistý zisk po daních" a={signedMoney(view.tradingGain)} b={signedMoney(view.passiveGain)} />
                        <PairRow label="Zhodnocení vložených peněz (před daní)" a={pct(view.returns.moneyWeighted.trading)} b={pct(view.returns.moneyWeighted.passive)} />
                        <PairRow label="TWR (jak ho ukazuje IBKR)" a={pct(view.returns.twr.trading)} b={pct(view.returns.twr.passive)} />
                    </tbody>
                </table>
            </div>
            <p className="subtext" style={{ marginBottom: 0 }}>
                TWR, který ukazuje IBKR, nebere ohled na to, kolik peněz bylo zrovna na účtu: týden s pár tisíci má stejnou váhu jako týden s miliony.
                Proto se může výrazně lišit od výsledku v korunách. Zhodnocení vložených peněz váží každou korunu dobou, po kterou byla investovaná, a odpovídá tedy rozdílu v korunách.
                S&P 500 YTD na webech bývá cenový index v USD bez dividend a bez kurzu koruny; tady je index v korunách s reinvestovanými dividendami.
            </p>
        </Section>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', gap: 16 }}>
            <Section title="Z čeho je zisk tradingu">
                <table style={tableStyle}><tbody>
                    <Row label="Realizované obchody — akcie a ETF" value={signedMoney(src.realized.securities)} />
                    <Row label="Realizované obchody — opce a deriváty" value={signedMoney(src.realized.derivatives)} />
                    {Math.round(src.realized.other) !== 0 && <Row label="Realizované obchody — ostatní" value={signedMoney(src.realized.other)} />}
                    <Row label="Otevřené pozice — akcie a ETF" hint="Nerealizovaný zisk/ztráta od nákupu." value={signedMoney(src.unrealized.securities)} />
                    <Row label="Otevřené pozice — opce a deriváty" value={signedMoney(src.unrealized.derivatives)} />
                    {Math.round(src.unrealized.other) !== 0 && <Row label="Otevřené pozice — ostatní" value={signedMoney(src.unrealized.other)} />}
                    <Row label="Dividendy (hrubé)" value={signedMoney(src.dividends)} />
                    <Row label="Sražená zahraniční daň" value={signedMoney(src.withheld)} />
                    <Row label="Přijaté úroky z hotovosti" value={signedMoney(src.interestReceived)} />
                    <Row label="Zaplacené úroky" value={signedMoney(src.interestPaid)} />
                    <Row label={view.carriedPositions === 0 ? 'Kurzové rozdíly, poplatky a ostatní' : 'Kurzové rozdíly, poplatky, ostatní a odečet zisku z minulých let'}
                        hint={view.carriedPositions === 0
                            ? 'Dopočet do změny hodnoty účtu. Jde hlavně o přecenění hotovosti v cizí měně na koruny.'
                            : 'Dopočet do změny hodnoty účtu. Kromě kurzových rozdílů odečítá zisk pozic z doby před začátkem roku, který řádky výše počítají od nákupu.'}
                        value={signedMoney(src.other)} />
                    <Row label="Hrubý zisk tradingu" value={signedMoney(view.grossGain.trading)} highlight />
                </tbody></table>
                {view.carriedPositions !== 0 && <p className="subtext" style={{ color: '#f59e0b' }}>
                    {view.carriedPositions === null
                        ? `Z výpisu nejde ověřit, jestli účet k ${fmtDate(view.startDate)} držel pozice (NAV ve Flex query nemá sloupec Cash).`
                        : `K ${fmtDate(view.startDate)} držel účet pozice v hodnotě ${money(view.carriedPositions)}.`}
                    {' '}Realizované obchody a otevřené pozice ukazují brokerův zisk od nákupu, tedy i část z minulých let, a poslední řádek ji dorovnává. Celkový hrubý zisk je správně, rozdělení mezi řádky ne.
                </p>}
                {view.cash && view.cash.length > 0 && <>
                    <h4 style={{ margin: '20px 0 4px' }}>Hotovost podle měn k {fmtDate(view.lastDate)}</h4>
                    <table style={tableStyle}><tbody>
                        {view.cash.map(row => <Row key={row.currency} label={`${row.currency} ${row.quantity.toLocaleString('cs-CZ', { maximumFractionDigits: 0 })}`}
                            hint={`${plainPct(row.share)} hodnoty účtu`} value={money(row.value)} />)}
                    </tbody></table>
                    {usdCash && usdCash.share > 0.3 && <p className="subtext" style={{ marginBottom: 0 }}>
                        Dolarová hotovost tvoří {plainPct(usdCash.share)} účtu. Pohyb kurzu USD/CZK proto mění hodnotu účtu podobně jako hodnotu indexu, který je celý v dolarech.
                    </p>}
                </>}
            </Section>

            <Section title="Daně a paušál u tradingu">
                {trading ? <table style={tableStyle}><tbody>
                    <Row label="Základ — akcie a ETF" hint={lostBasket(trading.securitiesGain) ?? 'Včetně uzavření otevřených pozic k poslednímu dni.'} value={signedMoney(trading.securitiesGain)} />
                    <Row label="Základ — opce a deriváty" hint={lostBasket(trading.derivativesGain) ?? 'Včetně uzavření otevřených pozic k poslednímu dni.'} value={signedMoney(trading.derivativesGain)} />
                    {Math.round(trading.otherGain) !== 0 && <Row label="Základ — ostatní" hint={lostBasket(trading.otherGain)} value={signedMoney(trading.otherGain)} />}
                    <Row label="Dividendy (hrubé)" value={money(trading.dividends)} />
                    <Row label="Úroky (hrubé)" value={money(trading.interest)} />
                    <Row label="Česká daň z investic" hint={`Po zahraničním zápočtu ${money(result.annual.find(row => row.year === String(view.year))?.trading.foreignCredit ?? 0)}.`} value={money(result.trading.investmentTax)} strong />
                    <Row label="Příjmy, které se počítají do limitu paušálu" hint={`Hrubé prodeje, dividendy a úroky. Limit je 50 000 Kč, ${trading.flatTaxIncome > 50_000 ? 'je překročen, takže paušál pro tento rok neplatí' : 'není překročen'}.`} value={money(trading.flatTaxIncome)} />
                    {result.trading.regimeCost !== 0 && <>
                        <Row label="Sociální pojištění v běžném režimu" value={money(trading.social)} />
                        <Row label="Zdravotní pojištění v běžném režimu" value={money(trading.health)} />
                        <Row label="Daň z podnikání po slevě na poplatníka" value={money(trading.businessIncomeTax)} />
                        <Row label="Paušální daň, kterou bys platil i bez tradingu" value={signedMoney(-trading.flatTaxPaid)} />
                    </>}
                    <Row label="Ztráta paušálního režimu" value={money(result.trading.regimeCost)} strong />
                    <Row label="Náklady tradingu celkem" value={money(result.trading.totalCost)} highlight />
                </tbody></table> : <p>Rozpad daně pro rok {view.year} není k dispozici.</p>}
                {trading && view.carriedPositions !== 0 && <p className="subtext" style={{ marginBottom: 0, color: '#f59e0b' }}>
                    Daň z uzavření pozic počítá zisk od nákupu, tedy i z doby před {fmtDate(view.startDate)}. Indexová varianta začíná nákupem k tomuto dni a tuto daň nenese, takže loňský zisk pozic zhoršuje a loňská ztráta zlepšuje výsledek tradingu.
                </p>}
            </Section>
        </div>

        <Section title="Index S&P 500 v korunách">
            <table style={tableStyle}><tbody>
                <Row label={`Cena SPY ${fmtDate(index.startPriceDate)} → ${fmtDate(index.endPriceDate)}`} hint="Starší cena je snížená o dividendy reinvestované po srážce, stejně jako upravená cena na Yahoo." value={`${usd(index.startPrice)} → ${usd(index.endPrice)}`} wrap />
                <Row label="Výnos v dolarech (vč. reinvestovaných dividend)" hint={`${index.dividendCount} ${index.dividendCount === 1 ? 'dividenda' : index.dividendCount >= 2 && index.dividendCount <= 4 ? 'dividendy' : 'dividend'} celkem ${usd(index.dividendsUsd)} na kus, reinvestované po ${plainPct(index.withholding)} srážce.`} value={pct(index.returnUsd)} />
                <Row label={`Kurz USD/CZK ${fmtDate(view.startDate)} → ${fmtDate(view.lastDate)}`} value={`${fxRate(index.startFx)} → ${fxRate(index.endFx)} (${pct(index.fxChange)})`} wrap />
                <Row label="Výnos indexu v korunách" value={pct(index.returnCzk)} strong />
                <Row label="Počet kusů, které by indexová varianta držela" value={index.units.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} />
                <Row label={`Hodnota k ${fmtDate(view.lastDate)}`} hint="kusy × cena v USD × kurz" value={money(result.passive.gross)} />
            </tbody></table>
            <p className="subtext">
                Index se oceňuje závěrečnou cenou SPY v New Yorku, tedy ve stejnou chvíli, ke které IBKR oceňuje tvůj účet. Dividendy se reinvestují po 15% srážce jako u akumulačního CSPX.
                CSPX samotné se zavírá v Londýně o 4,5 hodiny dřív a jeho cena by srovnání den ode dne posouvala o desítky tisíc korun.
            </p>
            {index.filledFromIntraday.length > 0 && <p className="subtext">
                Yahoo nemělo denní závěrečnou cenu pro {index.filledFromIntraday.map(fmtDate).join(', ')}. Použila se poslední hodinová cena téhož dne.
            </p>}
            <details style={{ marginTop: 12 }}>
                <summary style={summaryStyle}>Nákupy indexu podle tvých vkladů ({index.purchases.length})</summary>
                <div style={{ overflowX: 'auto' }}>
                    <table style={tableStyle}>
                        <thead><tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                            <th style={{ textAlign: 'left', padding: '6px 0', fontWeight: 500 }}>Den</th>
                            <th style={thStyle}>Vklad / výběr</th><th style={thStyle}>Cena</th><th style={thStyle}>Kurz</th><th style={thStyle}>Kusy</th>
                        </tr></thead>
                        <tbody>
                            {index.startUnits > 0 && <tr style={rowStyle}>
                                <td style={cellStyle}>{fmtDate(view.startDate)} (počáteční hodnota)</td>
                                <td style={numStyle}>{money(view.initialValue)}</td><td style={numStyle}>{usd(index.startPrice)}</td>
                                <td style={numStyle}>{fxRate(index.startFx)}</td><td style={numStyle}>{index.startUnits.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })}</td>
                            </tr>}
                            {index.purchases.map(purchase => <tr key={purchase.date} style={rowStyle}>
                                <td style={cellStyle}>{fmtDate(purchase.date)}</td>
                                <td style={numStyle}>{signedMoney(purchase.amount)}</td><td style={numStyle}>{usd(purchase.priceUsd)}</td>
                                <td style={numStyle}>{fxRate(purchase.fx)}</td><td style={numStyle}>{purchase.units.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })}</td>
                            </tr>)}
                        </tbody>
                    </table>
                </div>
                <p className="subtext">Vklad se do indexu „nakoupí“ závěrečnou cenou SPY (vč. reinvestovaných dividend) ke dni, kdy ho IBKR započítalo do hodnoty účtu. Výběr prodá odpovídající počet kusů.</p>
            </details>
        </Section>

        <Section title="Jak se rozdíl před daněmi vyvíjel">
            <p style={{ marginTop: 0 }}>
                Za posledních {recent.length} obchodních dní se rozdíl před daněmi pohyboval mezi <strong>{signedMoney(recentMin)}</strong> a <strong>{signedMoney(recentMax)}</strong>.
                Indexová varianta je celá v akciích, takže každé 1 % pohybu S&P 500 změní její hodnotu zhruba o <strong>{money(result.passive.gross * 0.01)}</strong>.
                Když je tvůj účet převážně v hotovosti, posune se o podobnou částku i rozdíl. Velké změny z týdne na týden jsou proto normální.
            </p>
            <div style={{ height: 280, width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={view.gapRows} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="date" tickFormatter={fmtDateShort} stroke="#94a3b8" minTickGap={40} />
                        <YAxis tickFormatter={thousands} stroke="#94a3b8" width={70} />
                        <ReferenceLine y={0} stroke="#475569" />
                        <Tooltip labelFormatter={value => fmtDate(String(value))} formatter={value => [signedMoney(Number(value)), 'Trading − index před daní']} contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }} />
                        <Line type="linear" dataKey="gross" name="Trading − index před daní" stroke={GAP_COLOR} dot={false} isAnimationActive={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <p className="subtext" style={{ marginBottom: 0 }}>Nad nulou je trading napřed. Konečný výsledek od toho ještě odečítá daň z tradingu a ztrátu paušálu ({money(result.trading.totalCost)}).</p>
        </Section>

        <details className="card" style={{ marginTop: 16 }}>
            <summary style={summaryStyle}>Výkonnost v % (TWR) v čase</summary>
            <p className="subtext">TWR očišťuje výnos o vklady a výběry, ale nezohledňuje, kolik peněz bylo kdy investováno.</p>
            <div style={{ height: 300, width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={view.twrRows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="date" tickFormatter={fmtDateShort} stroke="#94a3b8" minTickGap={40} />
                        <YAxis tickFormatter={value => `${value} %`} stroke="#94a3b8" />
                        <ReferenceLine y={0} stroke="#475569" />
                        <Tooltip labelFormatter={value => fmtDate(String(value))} formatter={(value, name) => [percent(Number(value)), name]} contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }} />
                        <Legend />
                        <Line type="linear" dataKey="portfolio" name="Trading" stroke={PORTFOLIO_COLOR} dot={false} isAnimationActive={false} />
                        <Line type="linear" dataKey="benchmark" name="S&P 500" stroke={BENCHMARK_COLOR} dot={false} isAnimationActive={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </details>

        <details className="card" style={{ marginTop: 16 }}>
            <summary style={summaryStyle}>Jak se výsledek počítá</summary>
            <p>Porovnávám uzavření tvých IBKR pozic s dlouhodobým držením S&P 500 přes akumulační ETF typu CSPX. Obě varianty začínají stejnou hodnotou a mají stejné vklady i výběry. Index se na konci neprodává a jeho hodnota se bere ke stejnému datu výpisu: závěrečná cena SPY v New Yorku s dividendami reinvestovanými po 15% srážce × kurz USD/CZK z IBKR.</p>
            <p>Daň z uzavřených obchodů a případný přechod do běžného režimu OSVČ jsou započítané. Zahraniční srážky, které už jsou v hodnotě účtu, se neodečítají podruhé. Z dostupných ročních způsobů zdanění dividend se automaticky použije ten výhodnější. Neověřené vrácení zahraniční daně se nepřičítá.</p>
            <p>Akcie a deriváty jsou v modelu oddělené koše: ztráta v jednom se nezapočítává proti zisku v druhém. Jestli to tak platí i pro tvé přiznání, je potřeba ověřit s daňovým poradcem.</p>
            <p>Budoucí růst indexu ani budoucí prodej se neodhaduje. Případné prodeje kvůli výběrům peněz se daní i u indexu.</p>
        </details>

        <details className="card" style={{ marginTop: 16 }}>
            <summary style={summaryStyle}>Podklady a přesnost odhadu</summary>
            <p>Model používá brokerovo P/L. Přesný český daňový přepočet nákupů a prodejů, opční přiřazení a chybějící data nabytí mohou částku daně změnit. Nezahrnuje další investice a příjmy mimo tento výpis.</p>
            <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        </details>
    </>;
}

function QuickVerdict({ view }: { view: Comparison }) {
    const difference = view.result.delta;
    const tied = Math.abs(difference) < 0.5;
    const tradingWins = difference > 0;
    const color = tied ? '#cbd5e1' : tradingWins ? '#4ade80' : '#fbbf24';
    const grossGap = view.result.trading.gross - view.result.passive.gross;
    return <div className="card" style={{ borderTop: `4px solid ${color}`, padding: '1.75rem' }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8 }}>
            {tied ? `Za rok ${view.year} zatím vycházejí obě varianty stejně.` : tradingWins
                ? `Za rok ${view.year} se ti zatím trading vyplatil.`
                : `Za rok ${view.year} by zatím vyšlo lépe držet index.`}
        </div>
        <div style={{ fontSize: 'clamp(2rem, 5vw, 3.4rem)', lineHeight: 1.2, fontWeight: 750, color }}>
            {money(Math.abs(difference))} {tied ? '' : tradingWins ? 'navíc' : 'méně'}
        </div>
        <p style={{ marginBottom: 0, color: 'var(--text-secondary)' }}>
            Před daněmi {signedMoney(grossGap)} · daň z tradingu {signedMoney(-view.result.trading.investmentTax)} · ztráta paušálu {signedMoney(-view.result.trading.regimeCost)}
        </p>
        <p className="subtext" style={{ marginBottom: 0 }}>
            Trading je zdaněný, jako by se všechny pozice uzavřely k {fmtDate(view.lastDate)}. Index se neprodává a zůstává držený, takže jeho daň zatím nevzniká.
        </p>
    </div>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
    return <section className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
    </section>;
}
function Row({ label, value, hint, color, strong = false, highlight = false, wrap = false }: {
    label: string; value: string; hint?: string; color?: string; strong?: boolean; highlight?: boolean; wrap?: boolean;
}) {
    return <tr style={highlight ? { ...rowStyle, borderTop: '2px solid #475569' } : rowStyle}>
        <td style={cellStyle}>
            <div style={{ color: strong || highlight ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{label}</div>
            {hint && <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 2 }}>{hint}</div>}
        </td>
        <td style={{ ...numStyle, color, fontWeight: highlight ? 750 : strong ? 700 : 600, fontSize: highlight ? '1rem' : undefined,
            ...(wrap ? { whiteSpace: 'normal' } : {}) }}>{value}</td>
    </tr>;
}
function PairRow({ label, a, b, strong = false }: { label: string; a: string; b: string; strong?: boolean }) {
    const weight = strong ? 700 : 600;
    return <tr style={rowStyle}>
        <td style={{ ...cellStyle, color: strong ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{label}</td>
        <td style={{ ...numStyle, paddingLeft: 8, fontWeight: weight }}>{a}</td>
        <td style={{ ...numStyle, paddingLeft: 8, fontWeight: weight }}>{b}</td>
    </tr>;
}
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' };
const rowStyle: React.CSSProperties = { borderBottom: '1px solid #334155' };
const cellStyle: React.CSSProperties = { padding: '10px 0', verticalAlign: 'top' };
const numStyle: React.CSSProperties = { padding: '10px 0 10px 12px', textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top', fontVariantNumeric: 'tabular-nums' };
const thStyle: React.CSSProperties = { padding: '6px 0 6px 12px', fontWeight: 500 };
const summaryStyle: React.CSSProperties = { cursor: 'pointer', fontWeight: 650, marginBottom: 12 };
const inputStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #475569', borderRadius: 6, background: '#0f172a', color: '#f1f5f9', maxWidth: '100%' };
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
