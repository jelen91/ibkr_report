'use client';

interface CapitalAllocationChartProps {
    stockValue: number;
    optionValue: number;
    cryptoValue: number;
    otherValue: number;
    cashBalance: number;
    total: number;
    acctBaseCurrency: string;
}

export default function CapitalAllocationChart(props: CapitalAllocationChartProps) {
    const rows = [
        { name: 'Hotovost', value: props.cashBalance },
        { name: 'Akcie (netto)', value: props.stockValue },
        { name: 'Opce (netto)', value: props.optionValue },
        { name: 'Krypto (netto)', value: props.cryptoValue },
        { name: 'Ostatní aktiva a časové rozlišení', value: props.otherValue },
    ];
    const scale = Math.max(1, ...rows.map(row => Math.abs(row.value)));
    const format = (value: number) => `${value.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} ${props.acctBaseCurrency}`;
    return <div className="card chart-card" style={{ padding: '1.5rem' }}>
        <h3>Složení čisté hodnoty účtu</h3>
        <div style={{ width: '100%' }}>
            {rows.map(row => <div key={row.name} style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span>{row.name}</span><strong>{format(row.value)}</strong>
                </div>
                <div style={{ position: 'relative', height: 10, background: '#334155', marginTop: 6, borderRadius: 4 }}>
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, borderLeft: '1px solid #94a3b8' }} />
                    <div style={{ position: 'absolute', height: '100%', width: `${Math.abs(row.value) / scale * 50}%`,
                        ...(row.value < 0 ? { right: '50%' } : { left: '50%' }), background: row.value < 0 ? '#ef4444' : '#3b82f6' }} />
                </div>
            </div>)}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #64748b', paddingTop: 10 }}>
                <strong>Čistá hodnota celkem</strong><strong>{format(props.total)}</strong>
            </div>
            <p className="subtext">Součet včetně záporných závazků odpovídá NAV z IBKR. Ostatní zahrnuje další instrumenty a rozdíl vůči souhrnu NAV.</p>
        </div>
    </div>;
}
