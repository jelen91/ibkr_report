'use client';

import { useState, useEffect, useMemo } from 'react';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { Account } from '../types';
import type { NavPoint } from '../lib/twr';

// ─── typy ─────────────────────────────────────────────────────────────────────

interface Quote {
    symbol: string;
    name: string;
    currency: string;
    price: number;
    history: Record<string, number>;
}

interface QuotesPayload {
    quotes: Record<string, Quote>;
    fx: Record<string, Quote>;
    btc: Quote | null;
    failed: string[];
}

/** Cenný papír držený mimo IBKR — množství zadáváš ty, cenu dotahujeme sami. */
interface HoldingRow {
    id: string;
    symbol: string;
    quantity: number;
    note: string;
}

/** Hotovost nebo cokoli, co se nedá nacenit z burzy. */
interface ManualRow {
    id: string;
    name: string;
    amount: number;
    currency: string;
}

const LS_ACCOUNTS = 'ibkr_accounts';
const LS_OVERVIEW = 'ibkr_overview';

// Předvyplněno podle toho, co držíš. Symboly jsou německé listingy, které nabízí
// XTB; kdyby ses trefil do jiné burzy, přepiš je — pod řádkem se vždycky ukáže
// celý název fondu, takže si ověříš, že sedí.
const DEFAULT_HOLDINGS: HoldingRow[] = [
    { id: 'h1', symbol: 'XDWH.DE', quantity: 12.9633, note: 'MSCI World Health Care' },
    { id: 'h2', symbol: 'SXR8.DE', quantity: 0, note: 'iShares Core S&P 500 (XTB)' },
    { id: 'h3', symbol: 'EUNL.DE', quantity: 0, note: 'iShares Core MSCI World (XTB)' },
];

const DEFAULT_MANUAL: ManualRow[] = [
    { id: 'm1', name: 'Air Bank', amount: 0, currency: 'CZK' },
];

const COLORS = ['#38bdf8', '#f59e0b', '#4ade80', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c'];

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (ymd: string) =>
    ymd.length === 8 ? `${ymd.slice(6, 8)}.${ymd.slice(4, 6)}.${ymd.slice(0, 4)}` : ymd;

const fmtDateShort = (ymd: string) =>
    ymd.length === 8 ? `${+ymd.slice(6, 8)}.${+ymd.slice(4, 6)}.` : ymd;

const fmtCzk = (v: number) => Math.round(v).toLocaleString('cs-CZ') + ' Kč';

const fmtNum = (v: number, digits = 4) =>
    v.toLocaleString('cs-CZ', { maximumFractionDigits: digits });

const todayYmd = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/** Poslední známá hodnota k danému dni — kurzy nejsou o víkendech a svátcích. */
function valueAt(history: Record<string, number>, date: string, sortedKeys: string[]): number | null {
    if (history[date] !== undefined) return history[date];
    let lo = 0, hi = sortedKeys.length - 1, best: number | null = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedKeys[mid] <= date) { best = history[sortedKeys[mid]]; lo = mid + 1; }
        else hi = mid - 1;
    }
    return best;
}

// ─── komponenta ───────────────────────────────────────────────────────────────

export default function OverviewPage() {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [ibkrNav, setIbkrNav] = useState<Record<string, NavPoint[]>>({});
    const [ibkrLoading, setIbkrLoading] = useState(false);
    const [ibkrError, setIbkrError] = useState<string | null>(null);

    const [holdings, setHoldings] = useState<HoldingRow[]>(DEFAULT_HOLDINGS);
    const [manual, setManual] = useState<ManualRow[]>(DEFAULT_MANUAL);
    const [btcAmount, setBtcAmount] = useState(0);

    const [quotes, setQuotes] = useState<QuotesPayload | null>(null);
    const [quotesError, setQuotesError] = useState<string | null>(null);

    // Dokud se nedočte uložený stav, nesmí se nic zapisovat. React ve StrictModu
    // pouští efekty při mountu dvakrát a ukládací efekt by v prvním průchodu
    // stihl přepsat localStorage výchozími hodnotami dřív, než se do stavu vůbec
    // dostane to, co tam bylo uložené — a načítací efekt by pak ve druhém
    // průchodu přečetl už jen ty výchozí hodnoty.
    const [hydrated, setHydrated] = useState(false);

    // ── načtení uloženého stavu ──
    useEffect(() => {
        try {
            const raw = localStorage.getItem(LS_ACCOUNTS);
            const saved: Account[] = raw ? JSON.parse(raw) : [];
            setAccounts(saved);
            if (saved.length > 0) loadIbkr(saved);
        } catch { /* bez účtů se ukáže jen zbytek */ }

        try {
            const st = JSON.parse(localStorage.getItem(LS_OVERVIEW) || '{}');
            if (Array.isArray(st.holdings)) setHoldings(st.holdings);
            if (Array.isArray(st.manual)) setManual(st.manual);
            if (typeof st.btcAmount === 'number') setBtcAmount(st.btcAmount);
        } catch { /* výchozí hodnoty */ }

        setHydrated(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── uložení ──
    useEffect(() => {
        if (!hydrated) return;
        localStorage.setItem(LS_OVERVIEW, JSON.stringify({ holdings, manual, btcAmount }));
    }, [hydrated, holdings, manual, btcAmount]);

    // ── kurzy ──
    // Debounce, aby se při psaní tickeru neposílal dotaz na každý znak.
    useEffect(() => {
        const symbols = holdings.filter(h => h.symbol.trim()).map(h => h.symbol.trim());
        const timer = setTimeout(() => {
            const url = `/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}&btc=1&range=1y`;
            setQuotesError(null);
            fetch(url)
                .then(async res => {
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Kurzy se nepodařilo načíst');
                    setQuotes(json);
                })
                .catch(e => setQuotesError(e.message));
        }, 500);
        return () => clearTimeout(timer);
    }, [holdings.map(h => h.symbol).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    // Účty se načítají nezávisle na sobě: `Promise.all` by při jediném selhání
    // zahodil i data účtů, které se stáhly v pořádku, a v přehledu by pak IBKR
    // chybělo celé.
    async function loadIbkr(list: Account[]) {
        setIbkrLoading(true);
        setIbkrError(null);

        const results = await Promise.allSettled(list.map(async acct => {
            const res = await fetch('/api/performance', {
                headers: { 'x-flex-token': acct.token, 'x-flex-query-id': acct.queryId },
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Chyba načítání');
            return [acct.id, json.nav as NavPoint[]] as const;
        }));

        const loaded: Record<string, NavPoint[]> = {};
        const failures: string[] = [];
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') loaded[r.value[0]] = r.value[1];
            else failures.push(`${list[i].name}: ${r.reason?.message ?? r.reason}`);
        });

        setIbkrNav(loaded);
        setIbkrError(failures.length ? failures.join(' · ') : null);
        setIbkrLoading(false);
    }

    // ── výpočet ──
    const view = useMemo(() => {
        const fxCzk = (currency: string, date: string): number => {
            if (currency === 'CZK') return 1;
            const q = quotes?.fx[currency];
            if (!q) return 0;
            const keys = Object.keys(q.history).sort();
            return valueAt(q.history, date, keys) ?? q.price;
        };

        const today = todayYmd();

        // ── jednotlivé složky k dnešku ──
        const parts: { key: string; label: string; value: number; detail: string }[] = [];

        // Rozpad po účtech, ať je vidět, který se načetl a který ne — souhrnný
        // řádek s nulou by jinak vypadal, jako by se IBKR do přehledu nedostalo.
        const ibkrRows = accounts.map(acct => {
            const series = ibkrNav[acct.id];
            const last = series?.length ? series[series.length - 1] : null;
            return {
                account: acct,
                value: last?.nav ?? 0,
                date: last?.date ?? null,
                loaded: !!last,
            };
        });
        const ibkrTotal = ibkrRows.reduce((s, r) => s + r.value, 0);

        if (accounts.length > 0) {
            parts.push({
                key: 'ibkr',
                label: accounts.length > 1 ? `IBKR (${accounts.length} účty)` : 'IBKR',
                value: ibkrTotal,
                detail: accounts.map(a => a.name).join(', '),
            });
        }

        const btcQuote = quotes?.btc ?? null;
        const btcValue = btcQuote ? btcAmount * btcQuote.price : 0;
        if (btcAmount > 0) {
            parts.push({
                key: 'btc',
                label: 'Bitcoin',
                value: btcValue,
                detail: `${fmtNum(btcAmount, 8)} BTC × ${fmtCzk(btcQuote?.price ?? 0)}`,
            });
        }

        const holdingValues = holdings.map(h => {
            const q = quotes?.quotes[h.symbol.trim()];
            const rate = q ? fxCzk(q.currency, today) : 0;
            const value = q ? h.quantity * q.price * rate : 0;
            return { row: h, quote: q ?? null, value };
        });

        for (const hv of holdingValues) {
            if (hv.value <= 0) continue;
            parts.push({
                key: `h:${hv.row.id}`,
                label: hv.row.note || hv.row.symbol,
                value: hv.value,
                detail: `${fmtNum(hv.row.quantity)} ks × ${fmtNum(hv.quote?.price ?? 0, 2)} ${hv.quote?.currency ?? ''}`,
            });
        }

        for (const m of manual) {
            if (!m.amount) continue;
            const rate = fxCzk(m.currency, today);
            parts.push({
                key: `m:${m.id}`,
                label: m.name || 'Ruční položka',
                value: m.amount * rate,
                detail: m.currency === 'CZK' ? 'ruční zadání' : `${fmtNum(m.amount, 2)} ${m.currency}`,
            });
        }

        const total = parts.reduce((s, p) => s + p.value, 0);

        // ── historie ────────────────────────────────────────────────────────
        // Tržní složky mají skutečnou cenovou historii; ruční položky ji nemají,
        // takže se drží na dnešní hodnotě. Množství se bere dnešní — graf tedy
        // ukazuje, jak by se dnešní majetek vyvíjel, ne co jsi kdy dokupoval.
        const dateSet = new Set<string>();
        for (const acct of accounts) for (const p of ibkrNav[acct.id] ?? []) dateSet.add(p.date);
        if (btcAmount > 0 && btcQuote) for (const d of Object.keys(btcQuote.history)) dateSet.add(d);
        for (const hv of holdingValues) {
            if (hv.value > 0 && hv.quote) for (const d of Object.keys(hv.quote.history)) dateSet.add(d);
        }

        const dates = [...dateSet].sort();
        const manualTotal = manual.reduce((s, m) => s + m.amount * fxCzk(m.currency, today), 0);

        const ibkrKeys: Record<string, string[]> = {};
        const ibkrHist: Record<string, Record<string, number>> = {};
        for (const acct of accounts) {
            const series = ibkrNav[acct.id] ?? [];
            const h: Record<string, number> = {};
            for (const p of series) h[p.date] = p.nav;
            ibkrHist[acct.id] = h;
            ibkrKeys[acct.id] = series.map(p => p.date);
        }

        const btcKeys = btcQuote ? Object.keys(btcQuote.history).sort() : [];
        const holdingKeys = holdingValues.map(hv => hv.quote ? Object.keys(hv.quote.history).sort() : []);
        const fxKeysByCurrency: Record<string, string[]> = {};
        for (const [code, q] of Object.entries(quotes?.fx ?? {})) {
            fxKeysByCurrency[code] = Object.keys(q.history).sort();
        }
        const fxAt = (currency: string, date: string) => {
            if (currency === 'CZK') return 1;
            const q = quotes?.fx[currency];
            if (!q) return 0;
            return valueAt(q.history, date, fxKeysByCurrency[currency] ?? []) ?? q.price;
        };

        const chart = dates.map(date => {
            let ibkr = 0;
            for (const acct of accounts) {
                const v = valueAt(ibkrHist[acct.id], date, ibkrKeys[acct.id]);
                if (v !== null) ibkr += v;
            }

            const btc = btcQuote && btcAmount > 0
                ? btcAmount * (valueAt(btcQuote.history, date, btcKeys) ?? 0)
                : 0;

            let etf = 0;
            holdingValues.forEach((hv, i) => {
                if (!hv.quote || hv.value <= 0) return;
                const price = valueAt(hv.quote.history, date, holdingKeys[i]);
                if (price === null) return;
                etf += hv.row.quantity * price * fxAt(hv.quote.currency, date);
            });

            return {
                date,
                IBKR: Math.round(ibkr),
                Bitcoin: Math.round(btc),
                ETF: Math.round(etf),
                Ostatní: Math.round(manualTotal),
                total: Math.round(ibkr + btc + etf + manualTotal),
            };
        }).filter(r => r.total > 0);

        // Stejný problém jako u výkonnosti: dokud byl účet skoro prázdný, dělaly
        // by drobné částky nesmyslná procenta (+55 000 % apod.). Graf proto
        // začíná až tam, kde majetek dosáhl 2 % svého maxima.
        const peak = Math.max(0, ...chart.map(r => r.total));
        const firstMeaningful = chart.findIndex(r => r.total >= peak * 0.02);
        const trimmed = firstMeaningful > 0 ? chart.slice(firstMeaningful) : chart;

        // růst za období, které graf pokrývá
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        const growth = first && last && first.total > 0
            ? { abs: last.total - first.total, pct: (last.total / first.total - 1) * 100, from: first.date }
            : null;

        return { parts, total, chart: trimmed, growth, holdingValues, btcQuote, btcValue, ibkrRows, ibkrTotal };
    }, [accounts, ibkrNav, holdings, manual, btcAmount, quotes]);

    // ── editace ──
    const updateHolding = (id: string, patch: Partial<HoldingRow>) =>
        setHoldings(rows => rows.map(r => (r.id === id ? { ...r, ...patch } : r)));
    const updateManual = (id: string, patch: Partial<ManualRow>) =>
        setManual(rows => rows.map(r => (r.id === id ? { ...r, ...patch } : r)));

    return (
        <div className="app">
            <header className="dashboard-header">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h1 style={{ margin: 0 }}>Celkový majetek</h1>
                    <button
                        onClick={() => accounts.length > 0 && loadIbkr(accounts)}
                        style={tabStyle(false)}
                        disabled={ibkrLoading}
                    >
                        {ibkrLoading ? '⟳ Načítám…' : '⟳ Obnovit'}
                    </button>
                </div>
            </header>

            <div className="content-container">
                {/* ── celkem ── */}
                <div className="card" style={{ borderLeft: `4px solid ${COLORS[0]}` }}>
                    <h3 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Dohromady vlastníš</h3>
                    <div style={{ fontSize: '2.4rem', fontWeight: 700, color: COLORS[0], lineHeight: 1.2 }}>
                        {fmtCzk(view.total)}
                    </div>
                    {view.growth && (
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
                            Od {fmtDate(view.growth.from)}{' '}
                            <strong style={{ color: view.growth.abs >= 0 ? 'var(--success-color)' : 'var(--danger-color)' }}>
                                {view.growth.abs >= 0 ? '+' : ''}{fmtCzk(view.growth.abs)}
                            </strong>
                            {' '}— je v tom ale i to, co jsi mezitím vložil, takže to není výnos.
                            {' '}Ten najdeš na záložce <a href="/performance" style={{ color: COLORS[0] }}>Výkonnost</a>.
                        </div>
                    )}

                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginTop: '1rem' }}>
                        <tbody>
                            {view.parts.map((p, i) => (
                                <tr key={p.key} style={{ borderBottom: '1px solid #334155' }}>
                                    <td style={{ padding: '0.5rem 0', width: '10px' }}>
                                        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: COLORS[i % COLORS.length] }} />
                                    </td>
                                    <td style={{ padding: '0.5rem 0.5rem' }}>
                                        {p.label}
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>{p.detail}</span>
                                    </td>
                                    <td style={{ padding: '0.5rem 0', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                        {view.total > 0 ? ((p.value / view.total) * 100).toFixed(1) + ' %' : ''}
                                    </td>
                                    <td style={{ padding: '0.5rem 0 0.5rem 1rem', textAlign: 'right', fontWeight: 600 }}>
                                        {fmtCzk(p.value)}
                                    </td>
                                </tr>
                            ))}
                            <tr>
                                <td />
                                <td style={{ padding: '0.6rem 0.5rem', fontWeight: 700 }}>Celkem</td>
                                <td />
                                <td style={{ padding: '0.6rem 0 0.6rem 1rem', textAlign: 'right', fontWeight: 700, color: COLORS[0] }}>
                                    {fmtCzk(view.total)}
                                </td>
                            </tr>
                        </tbody>
                    </table>

                    {ibkrError && (
                        <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: 0 }}>IBKR: {ibkrError}</p>
                    )}
                    {quotesError && (
                        <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: 0 }}>Kurzy: {quotesError}</p>
                    )}
                    {quotes?.failed?.length ? (
                        <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: 0 }}>
                            Nepodařilo se nacenit: {quotes.failed.join(', ')} — zkontroluj ticker.
                        </p>
                    ) : null}
                </div>

                {/* ── graf ── */}
                {view.chart.length > 1 && (
                    <div className="card" style={{ padding: '1rem' }}>
                        <h3 style={{ margin: '0 0 0.75rem' }}>Vývoj v čase</h3>
                        <div style={{ width: '100%', height: 340 }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={view.chart} margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis dataKey="date" tickFormatter={fmtDateShort} tick={{ fill: '#94a3b8', fontSize: 11 }} minTickGap={40} stroke="#334155" />
                                    <YAxis
                                        tickFormatter={(v: number) => (v / 1_000_000).toFixed(1) + ' M'}
                                        tick={{ fill: '#94a3b8', fontSize: 11 }}
                                        stroke="#334155"
                                        width={50}
                                    />
                                    <Tooltip
                                        labelFormatter={(l: any) => fmtDate(String(l))}
                                        formatter={(v: any, name: any) => [fmtCzk(Number(v)), name]}
                                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }}
                                        itemStyle={{ color: '#f1f5f9' }}
                                    />
                                    <Legend wrapperStyle={{ fontSize: '0.8rem' }} />
                                    {(['IBKR', 'ETF', 'Bitcoin', 'Ostatní'] as const).map((k, i) => (
                                        <Area
                                            key={k} type="monotone" dataKey={k} stackId="1"
                                            stroke={COLORS[i]} fill={COLORS[i]} fillOpacity={0.25}
                                            isAnimationActive={false}
                                        />
                                    ))}
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.75rem 0 0', lineHeight: 1.7 }}>
                            IBKR má skutečnou denní historii z flex query. ETF a bitcoin se dopočítávají
                            z <strong>dnešního množství</strong> a historických cen — graf tedy ukazuje, jak by se
                            choval dnešní majetek, ne kdy jsi co dokupoval. Ruční položky historii nemají, drží se
                            na dnešní hodnotě.
                        </p>
                    </div>
                )}

                {/* ── IBKR ── */}
                <div className="card">
                    <h3 style={{ marginTop: 0 }}>Interactive Brokers</h3>

                    {accounts.length === 0 ? (
                        <p style={{ margin: 0, fontSize: '0.85rem' }}>
                            Nemáš tu uložený žádný IBKR účet, proto se do součtu nic nezapočítalo.
                            Přidej ho na záložce{' '}
                            <a href="/" style={{ color: COLORS[0] }}>Portfolio IBKR</a> — účty se ukládají
                            do prohlížeče a tahle stránka je pak najde sama.
                        </p>
                    ) : (
                        <>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                                <tbody>
                                    {view.ibkrRows.map(r => (
                                        <tr key={r.account.id} style={{ borderBottom: '1px solid #334155' }}>
                                            <td style={tdStyle}>{r.account.name}</td>
                                            <td style={{ ...tdStyle, color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                                                {r.loaded ? `k ${fmtDate(r.date!)}` : (ibkrLoading ? 'načítám…' : 'nenačteno')}
                                            </td>
                                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                                                {r.loaded ? fmtCzk(r.value) : '—'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                                Hodnota je čistá likvidační hodnota účtu ze stejného flex query, jaké používá
                                záložka Výkonnost. První načtení po delší pauze trvá kolem deseti sekund.
                            </p>
                        </>
                    )}
                </div>

                {/* ── bitcoin ── */}
                <div className="card">
                    <h3 style={{ marginTop: 0 }}>Bitcoin</h3>
                    <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <input
                            type="number" step="0.00000001"
                            value={btcAmount || ''}
                            onChange={e => setBtcAmount(Number(e.target.value) || 0)}
                            placeholder="0.0"
                            style={{ ...inputStyle, width: '150px' }}
                        />
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            BTC × {fmtCzk(view.btcQuote?.price ?? 0)} ={' '}
                            <strong style={{ color: 'var(--text-primary)' }}>{fmtCzk(view.btcValue)}</strong>
                        </span>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                        Kurz z CoinGecko, rovnou v korunách.
                    </p>
                </div>

                {/* ── ETF ── */}
                <div className="card">
                    <h3 style={{ marginTop: 0 }}>ETF mimo IBKR</h3>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid #475569' }}>
                                <th style={thStyle}>Ticker</th>
                                <th style={thStyle}>Počet kusů</th>
                                <th style={thStyle}>Poznámka</th>
                                <th style={{ ...thStyle, textAlign: 'right' }}>Cena</th>
                                <th style={{ ...thStyle, textAlign: 'right' }}>Hodnota</th>
                                <th style={thStyle} />
                            </tr>
                        </thead>
                        <tbody>
                            {view.holdingValues.map(hv => (
                                <tr key={hv.row.id} style={{ borderBottom: '1px solid #334155' }}>
                                    <td style={tdStyle}>
                                        <input
                                            value={hv.row.symbol}
                                            onChange={e => updateHolding(hv.row.id, { symbol: e.target.value.toUpperCase() })}
                                            style={{ ...inputStyle, width: '110px' }}
                                        />
                                        {hv.quote && (
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: 2, maxWidth: 180 }}>
                                                {hv.quote.name}
                                            </div>
                                        )}
                                    </td>
                                    <td style={tdStyle}>
                                        <input
                                            type="number" step="0.0001"
                                            value={hv.row.quantity || ''}
                                            onChange={e => updateHolding(hv.row.id, { quantity: Number(e.target.value) || 0 })}
                                            style={{ ...inputStyle, width: '110px' }}
                                        />
                                    </td>
                                    <td style={tdStyle}>
                                        <input
                                            value={hv.row.note}
                                            onChange={e => updateHolding(hv.row.id, { note: e.target.value })}
                                            style={{ ...inputStyle, width: '190px' }}
                                        />
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                                        {hv.quote ? `${fmtNum(hv.quote.price, 2)} ${hv.quote.currency}` : '—'}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                                        {hv.value > 0 ? fmtCzk(hv.value) : '—'}
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                                        <button
                                            onClick={() => setHoldings(rows => rows.filter(r => r.id !== hv.row.id))}
                                            style={removeStyle}
                                            title="Odebrat"
                                        >✕</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <button
                        onClick={() => setHoldings(rows => [...rows, {
                            id: crypto.randomUUID(), symbol: '', quantity: 0, note: '',
                        }])}
                        style={{ ...tabStyle(false), marginTop: '0.75rem' }}
                    >+ Přidat ETF</button>
                </div>

                {/* ── ruční položky ── */}
                <div className="card">
                    <h3 style={{ marginTop: 0 }}>Hotovost a ruční položky</h3>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid #475569' }}>
                                <th style={thStyle}>Název</th>
                                <th style={thStyle}>Částka</th>
                                <th style={thStyle}>Měna</th>
                                <th style={{ ...thStyle, textAlign: 'right' }}>V korunách</th>
                                <th style={thStyle} />
                            </tr>
                        </thead>
                        <tbody>
                            {manual.map(m => {
                                const part = view.parts.find(p => p.key === `m:${m.id}`);
                                return (
                                    <tr key={m.id} style={{ borderBottom: '1px solid #334155' }}>
                                        <td style={tdStyle}>
                                            <input
                                                value={m.name}
                                                onChange={e => updateManual(m.id, { name: e.target.value })}
                                                style={{ ...inputStyle, width: '190px' }}
                                            />
                                        </td>
                                        <td style={tdStyle}>
                                            <input
                                                type="number"
                                                value={m.amount || ''}
                                                onChange={e => updateManual(m.id, { amount: Number(e.target.value) || 0 })}
                                                style={{ ...inputStyle, width: '130px' }}
                                            />
                                        </td>
                                        <td style={tdStyle}>
                                            <select
                                                value={m.currency}
                                                onChange={e => updateManual(m.id, { currency: e.target.value })}
                                                style={{ ...inputStyle, width: 'auto' }}
                                            >
                                                {['CZK', 'EUR', 'USD'].map(c => <option key={c} value={c}>{c}</option>)}
                                            </select>
                                        </td>
                                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>
                                            {part ? fmtCzk(part.value) : '—'}
                                        </td>
                                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                                            <button
                                                onClick={() => setManual(rows => rows.filter(r => r.id !== m.id))}
                                                style={removeStyle}
                                                title="Odebrat"
                                            >✕</button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <button
                        onClick={() => setManual(rows => [...rows, {
                            id: crypto.randomUUID(), name: '', amount: 0, currency: 'CZK',
                        }])}
                        style={{ ...tabStyle(false), marginTop: '0.75rem' }}
                    >+ Přidat položku</button>

                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0, marginTop: '1rem', lineHeight: 1.7 }}>
                        <strong>Air Bank musí zůstat ruční.</strong> Banka sice API má, ale je to PSD2 rozhraní pro
                        licencované poskytovatele služeb — vyžaduje registraci u ČNB a eIDAS certifikát, takže se do
                        něj jako fyzická osoba nedostaneš. Zůstatek si sem tedy přepiš ručně; kdyby ses někdy
                        k přístupu dostal, stačí doplnit další zdroj vedle IBKR.
                    </p>
                </div>

                <div style={{ height: '2rem' }} />
            </div>
        </div>
    );
}

// ─── styly ────────────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
    padding: '0.5rem 0.5rem 0.5rem 0',
    textAlign: 'left',
    fontSize: '0.72rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-secondary)',
    fontWeight: 600,
};

const tdStyle: React.CSSProperties = { padding: '0.5rem 0.5rem 0.5rem 0', verticalAlign: 'top' };

const inputStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#f1f5f9',
    fontSize: '0.8rem',
};

const removeStyle: React.CSSProperties = {
    fontSize: '0.7rem',
    padding: '2px 6px',
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
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
