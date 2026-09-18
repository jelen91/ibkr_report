'use client';

import type { ExposureCategory, ExposureResult } from '../lib/exposure';

const categories: { key: ExposureCategory; label: string; color: string }[] = [
    { key: 'equities', label: 'Akcie', color: '#38bdf8' },
    { key: 'commodities', label: 'Komodity', color: '#f59e0b' },
    { key: 'crypto', label: 'Krypto', color: '#a78bfa' },
];

export default function ExposureSummary({ exposure, nav, currency, onCategoryChange }: {
    exposure: ExposureResult;
    nav: number;
    currency: string;
    onCategoryChange: (key: string, category: ExposureCategory) => void;
}) {
    const money = (amount: number) => `${amount.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} ${currency}`;
    const percent = (amount: number) => nav > 0 && exposure.percentage !== null
        ? `${(amount / nav * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %` : '—';
    return <div className="card" style={{ marginBottom: '1rem', borderTop: '4px solid #22c55e' }}>
        <h3 style={{ marginTop: 0 }}>Rozpad expozice podle vázaného kapitálu</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
            {categories.map(category => <div key={category.key}>
                <div style={{ color: category.color, fontSize: '1.5rem', fontWeight: 700 }}>{percent(exposure.categories[category.key])}</div>
                <strong>{category.label}</strong>
                <div className="subtext">{money(exposure.categories[category.key])}</div>
            </div>)}
        </div>
        <p className="subtext" style={{ marginTop: '1rem' }}>
            Expozice = hodnota držených akcií, ETF a krypta + vázaný kapitál vypsaných PUT, děleno AUM.
            Akcie s covered CALL jsou započtené jednou. U zajištěného PUT spreadu se započítá pouze zbývající závazek.
            Nakoupené opce a pojistky se do tohoto ukazatele nepřičítají. Nejde o marži IBKR ani delta expozici.
        </p>
        {exposure.unsupported.length > 0 && <p role="status" style={{ color: '#f59e0b' }}>
            Úplnou expozici touto metodou nelze určit: {exposure.unsupported.join(' · ')}
        </p>}
        <details>
            <summary style={{ cursor: 'pointer' }}>Vázaný kapitál po titulech a zařazení kategorií</summary>
            <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead><tr style={{ textAlign: 'left' }}>
                        {['Ticker', 'Kategorie', 'Držené akcie / ETF / krypto', 'Závazek PUT', 'Vázaný kapitál', '% AUM'].map(label => <th key={label} style={{ padding: 8 }}>{label}</th>)}
                    </tr></thead>
                    <tbody>{exposure.rows.map(row => <tr key={row.key} style={{ borderTop: '1px solid #334155' }}>
                        <td style={{ padding: 8 }}><strong>{row.symbol}</strong></td>
                        <td style={{ padding: 8 }}><select
                            aria-label={`Kategorie ${row.symbol}`}
                            value={row.category}
                            onChange={event => onCategoryChange(row.key, event.target.value as ExposureCategory)}
                            style={{ background: '#0f172a', color: '#f1f5f9', border: '1px solid #475569', borderRadius: 4, padding: 4 }}
                        >{categories.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}</select></td>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(row.holdings)}</td>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(row.puts)}</td>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(row.total)}</td>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{percent(row.total)}</td>
                    </tr>)}</tbody>
                    <tfoot><tr style={{ borderTop: '1px solid #64748b', fontWeight: 700 }}>
                        <td style={{ padding: 8 }} colSpan={2}>Celkem{exposure.percentage === null ? ' (zahrnuté pozice)' : ''}</td>
                        <td style={{ padding: 8 }}>{money(exposure.investedHoldings)}</td>
                        <td style={{ padding: 8 }}>{money(exposure.putCommitments)}</td>
                        <td style={{ padding: 8 }}>{money(exposure.total)}</td>
                        <td style={{ padding: 8 }}>{percent(exposure.total)}</td>
                    </tr></tfoot>
                </table>
            </div>
            <p className="subtext">Kategorie jsou nastavené podle předlohy a lze je změnit. Změna kategorie nemění celkovou expozici.</p>
        </details>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', borderTop: '1px solid #334155', marginTop: '1rem', paddingTop: '1rem' }}>
            <div><strong>Nakoupené CALL: {money(exposure.longCalls)}</strong><div className="subtext">Aktuální tržní hodnota, mimo hlavní expozici.</div></div>
            <div><strong>Nakoupené PUT / pojistky: {money(exposure.longPuts)}</strong><div className="subtext">Aktuální tržní hodnota, mimo hlavní expozici.</div></div>
        </div>
    </div>;
}
