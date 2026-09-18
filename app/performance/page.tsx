'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { Account } from '../types';
import { mergeNavSeries } from '../lib/twr';
import { computePersonalComparison, type PersonalBenchmark, type PersonalSeries } from '../lib/personalComparison';

interface PerformanceSeries extends PersonalSeries { accountIds: string[] }
const PORTFOLIO_COLOR = '#38bdf8';
const BENCHMARK_COLOR = '#f59e0b';
const LS_ACCOUNTS = 'ibkr_accounts';
const LS_PROFILE = 'ibkr_personal_performance';
const fmtDate = (date: string) => `${date.slice(6, 8)}.${date.slice(4, 6)}.${date.slice(0, 4)}`;
const fmtDateShort = (date: string) => `${+date.slice(6, 8)}.${+date.slice(4, 6)}.`;
const money = (amount: number) => Number.isFinite(amount) ? `${(Math.round(amount) || 0).toLocaleString('cs-CZ')} Kč` : '—';
const signedMoney = (amount: number) => Number.isFinite(amount) ? `${amount > 0 ? '+' : ''}${money(amount)}` : '—';
const percent = (amount: number) => Number.isFinite(amount) ? `${amount > 0 ? '+' : ''}${amount.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} %` : '—';
function mergeSeries(list: PerformanceSeries[]): PerformanceSeries | null {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];

    const combined = mergeNavSeries(list);
    return {
        ...combined,
        warnings: [...new Set(list.flatMap(s => s.warnings ?? []))],
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
        fetch(`/api/benchmark?symbol=CSPX.L&from=${benchmarkFrom}&to=${benchmarkTo}`, { signal: controller.signal })
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
            {view && <>
                <p className="subtext">Rok {view.year} · data k {fmtDate(view.lastDate)} · stejné vklady a výběry · vše v Kč</p>
                <QuickVerdict view={view} />
                {view.partialYear && <p style={{ color: '#f59e0b' }}>Výpis začíná až {fmtDate(view.startDate)}. Výsledek pokrývá dostupnou část roku.</p>}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 16 }}>
                    <ValueCard label="Trading po daních" value={view.result.trading.net} gain={view.tradingGain} color={PORTFOLIO_COLOR} note="Po uzavření IBKR pozic a započtení změny paušálu." />
                    <ValueCard label="Držený index S&P 500" value={view.result.passive.net} gain={view.passiveGain} color={BENCHMARK_COLOR} note="Akumulační ETF CSPX dál držíš." />
                </div>
                <p className="subtext" style={{ margin: '12px 0 24px' }}>Odhad čistého výsledku podle výpisu. Zdanění se vybírá automaticky podle tvých údajů.</p>

                <details className="card" style={{ marginTop: 16 }}>
                    <summary style={summaryStyle}>Jak se výsledek počítá</summary>
                    <p>Porovnávám uzavření tvých IBKR pozic s dlouhodobým držením S&P 500 přes CSPX. Obě varianty začínají stejnou hodnotou a mají stejné vklady i výběry. Index se na konci neprodává a jeho hodnota se bere ke stejnému datu výpisu.</p>
                    <table style={tableStyle}><tbody>
                        <Row label="Náskok tradingu před dodatečnými náklady" value={signedMoney(view.result.trading.gross - view.result.passive.gross)} />
                        <Row label="Rozdíl v české dani z investic" value={signedMoney(view.result.passive.investmentTax - view.result.trading.investmentTax)} />
                        <Row label="Rozdíl kvůli ztrátě paušálního režimu" value={signedMoney(view.result.passive.regimeCost - view.result.trading.regimeCost)} />
                        <Row label="Čistý rozdíl trading − index" value={signedMoney(view.result.delta)} highlight />
                    </tbody></table>
                    <p>Daň z uzavřených obchodů a případný přechod do běžného režimu OSVČ jsou započítané. Zahraniční srážky, které už jsou v hodnotě účtu, se neodečítají podruhé. Z dostupných ročních způsobů zdanění dividend se automaticky použije ten výhodnější. Neověřené vrácení zahraniční daně se nepřičítá.</p>
                    <p>Budoucí růst indexu ani budoucí prodej se neodhaduje. Případné prodeje kvůli výběrům peněz se daní i u indexu.</p>
                    <table style={tableStyle}><tbody>
                        <Row label={`Počáteční hodnota k ${fmtDate(view.startDate)}`} value={money(view.initialValue)} />
                        <Row label="Čisté vklady a výběry" value={money(view.netContributions)} />
                        <Row label="Česká daň z investic — trading" value={money(view.result.trading.investmentTax)} />
                        <Row label="Dopad na paušál — trading" value={money(view.result.trading.regimeCost)} />
                        <Row label="Česká daň z investic — index" value={money(view.result.passive.investmentTax)} />
                        <Row label="Dopad na paušál — index" value={money(view.result.passive.regimeCost)} />
                    </tbody></table>
                    <details style={{ marginTop: 20 }}>
                        <summary style={summaryStyle}>Výkonnost před dodatečnou českou daní</summary>
                        <p className="subtext">TWR očišťuje výnos o vklady a výběry. Odpověď po daních v korunách je v hlavním přehledu nahoře.</p>
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
                                    <Line type="linear" dataKey="benchmark" name="S&P 500 (CSPX)" stroke={BENCHMARK_COLOR} dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </details>
                    <details style={{ marginTop: 20 }}>
                        <summary style={summaryStyle}>Podklady a přesnost odhadu</summary>
                        <p>Model používá brokerovo P/L. Přesný český daňový přepočet nákupů a prodejů, opční přiřazení a chybějící data nabytí mohou částku daně změnit. Nezahrnuje další investice a příjmy mimo tento výpis.</p>
                        <ul>{[...new Set([...(merged?.warnings ?? []), ...view.result.warnings])].map(warning => <li key={warning}>{warning}</li>)}</ul>
                    </details>
                </details>

            </>}
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
function QuickVerdict({ view }: { view: Comparison }) {
    const difference = view.result.delta;
    const tied = Math.abs(difference) < 0.5;
    const tradingWins = difference > 0;
    const color = tied ? '#cbd5e1' : tradingWins ? '#4ade80' : '#fbbf24';
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
            {tied ? 'Rozdíl po daních je menší než jedna koruna.' : tradingWins
                ? 'O tolik víc máš díky tradingu po daních a dopadu na paušální režim.'
                : 'O tolik méně máš po tradingu oproti drženému indexu, včetně daní a dopadu na paušální režim.'}
        </p>
    </div>;
}
function ValueCard({ label, value, gain, color, note }: { label: string; value: number; gain: number; color: string; note: string }) {
    return <div className="card">
        <h3 style={{ marginTop: 0 }}>{label}</h3>
        <div style={{ color, fontSize: '1.75rem', fontWeight: 700 }}>{money(value)}</div>
        <p style={{ margin: '8px 0' }}>Výsledek za období: <strong>{signedMoney(gain)}</strong></p>
        <p className="subtext" style={{ marginBottom: 0 }}>{note}</p>
    </div>;
}
function Row({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
    return <tr style={{ borderBottom: '1px solid #334155' }}>
        <td style={{ padding: '10px 0', color: 'var(--text-secondary)' }}>{label}</td>
        <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: highlight ? 750 : 600 }}>{value}</td>
    </tr>;
}
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' };
const summaryStyle: React.CSSProperties = { cursor: 'pointer', fontWeight: 650, marginBottom: 12 };
const inputStyle: React.CSSProperties = { padding: '8px 12px', border: '1px solid #475569', borderRadius: 6, background: '#0f172a', color: '#f1f5f9', maxWidth: '100%' };
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };
