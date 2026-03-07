import { useState } from 'react';

interface PositionCategoryProps {
    title: string;
    data: any[];
    columns: string[];
    color: string;
    netLiquidation: number;
    acctBaseCurrency: string;
}

export default function PositionCategory({ title, data, columns, color, netLiquidation, acctBaseCurrency }: PositionCategoryProps) {
    const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);

    if (!data || data.length === 0) return null;

    // Dynamic column header — Hodnota CZK → Hodnota EUR (or whatever the account base is)
    const colLabel = (col: string) => {
        if (col === 'Hodnota CZK') return `Hodnota ${acctBaseCurrency}`;
        if (col === 'Blokováno CZK') return `Blokováno ${acctBaseCurrency}`;
        return col;
    };

    const requestSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const getExpiryStyle = (expiry: string | number | undefined) => {
        if (!expiry) return {};
        const s = String(expiry);
        let targetDate: Date | null = null;
        if (s.includes('.')) {
            targetDate = new Date(s.split('.').reverse().join('-'));
        } else if (s.length === 8) {
            targetDate = new Date(`${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`);
        }
        let diffDays = 0;
        if (targetDate) {
            const today = new Date();
            diffDays = Math.ceil((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        }
        let bgColor, textColor = '#fff';
        if (diffDays <= 7) bgColor = '#ff4d4d';
        else if (diffDays <= 30) { bgColor = '#ffad33'; textColor = '#000'; }
        else if (diffDays <= 60) { bgColor = '#ffff66'; textColor = '#000'; }
        else { bgColor = '#4dff4d'; textColor = '#000'; }
        return { backgroundColor: bgColor, color: textColor, padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' };
    };

    const formatExpiry = (val: string | number | undefined) => {
        if (!val) return '-';
        const s = String(val);
        if (!s.includes('.') && s.length === 8) {
            return `${s.substring(6, 8)}.${s.substring(4, 6)}.${s.substring(0, 4)}`;
        }
        return s;
    };

    const sortedData = [...data].sort((a, b) => {
        if (!sortConfig) return 0;
        const getValue = (item: any, col: string) => {
            const p = item.value;
            switch (col) {
                case 'Ticker': return p.underlying || p.symbol;
                case 'Expirace': {
                    const s = String(p.expiry || '');
                    if (!s) return '99999999';
                    if (s.includes('.')) return s.split('.').reverse().join('');
                    return s;
                }
                case 'Strike': return Number(p.strike || 0);
                case 'Typ': return p.type;
                case 'Ks': return Number(p.quantity || 0);
                case 'Cena': return Number(p.markPrice || 0);
                case 'Hodnota':
                case 'Hodnota $': return Number(p.marketValue || 0);
                case 'Hodnota CZK': return Number(p.marketValue || 0) * (p.fxRateToBase || 1);
                case 'Blokováno':
                case 'Blokováno $': return Number(p.commitedCapital || 0);
                case 'Blokováno CZK': return Number(p.commitedCapital || 0) * (p.fxRateToBase || 1);
                case 'Avg Price': return Number(p.costBasisPrice || p.costPrice || 0);
                case 'P/L': return Number(p.unrealizedPnL || p.fifoPnlUnrealized || 0);
                case 'Cost Basis': return Number(p.costBasisPrice || p.costPrice || 0);
                case '%': {
                    const v = p.commitedCapital ? p.commitedCapital : p.marketValue;
                    return netLiquidation ? (Math.abs(v) * (p.fxRateToBase || 1)) / netLiquidation : 0;
                }
                default: return '';
            }
        };
        const valA = getValue(a, sortConfig.key);
        const valB = getValue(b, sortConfig.key);
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    return (
        <div className="card" style={{ marginBottom: '1rem', overflowX: 'auto', borderTop: `4px solid ${color}` }}>
            <h3 style={{ margin: '0 0 1rem 0' }}>{title}</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', color: '#eee' }}>
                <thead>
                    <tr style={{ borderBottom: '1px solid #444', textAlign: 'left', opacity: 0.7 }}>
                        {columns.map(c => (
                            <th
                                key={c}
                                style={{ padding: '8px', cursor: 'pointer', userSelect: 'none' }}
                                onClick={() => requestSort(c)}
                            >
                                {colLabel(c)} {sortConfig?.key === c ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sortedData.map((item, idx) => {
                        const p = item.value;
                        const valForPercent = p.commitedCapital ? p.commitedCapital : p.marketValue;
                        const valInBase = Math.abs(valForPercent) * (p.fxRateToBase || 1);
                        const percent = netLiquidation ? (valInBase / netLiquidation * 100).toFixed(2) : '0.00';

                        return (
                            <tr key={idx} style={{ borderBottom: '1px solid #222' }}>
                                {columns.map(col => {
                                    switch (col) {
                                        case 'Účet': {
                                            const acctName = (p as any).accountName || '—';
                                            const palette = [
                                                { bg: '#1e3a5f', color: '#93c5fd' }, // blue
                                                { bg: '#3a2610', color: '#fdba74' }, // orange
                                                { bg: '#1a3a2a', color: '#6ee7b7' }, // green
                                                { bg: '#3a2f0a', color: '#fde68a' }, // yellow
                                                { bg: '#2d1b4e', color: '#c4b5fd' }, // purple
                                                { bg: '#1f3a39', color: '#67e8f9' }, // cyan
                                            ];
                                            const hash = [...acctName].reduce((h, c) => h + c.charCodeAt(0), 0);
                                            const { bg, color } = palette[hash % palette.length];
                                            return (
                                                <td key={col} style={{ padding: '8px' }}>
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '4px',
                                                        background: bg, color,
                                                        fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
                                                    }}>
                                                        {acctName}
                                                    </span>
                                                </td>
                                            );
                                        }

                                        case 'Ticker':
                                            return <td key={col} style={{ padding: '8px', fontWeight: 'bold' }}>{p.underlying || p.symbol}</td>;


                                        case 'Expirace':
                                            return (
                                                <td key={col} style={{ padding: '8px' }}>
                                                    <span style={getExpiryStyle(p.expiry)}>{formatExpiry(p.expiry)}</span>
                                                </td>
                                            );

                                        case 'Strike':
                                            return <td key={col} style={{ padding: '8px' }}>{p.strike || '-'}</td>;

                                        case 'Typ':
                                            return (
                                                <td key={col} style={{ padding: '8px' }}>
                                                    <span style={{
                                                        padding: '2px 6px', borderRadius: '4px',
                                                        background: p.type === 'PUT' ? '#4a1d1d' : p.type === 'CALL' ? '#1d4a1d' : '#333',
                                                        fontSize: '0.8em'
                                                    }}>
                                                        {p.type || '-'}
                                                    </span>
                                                </td>
                                            );

                                        case 'Asset':
                                            return <td key={col} style={{ padding: '8px', opacity: 0.7 }}>{p.assetClass}</td>;

                                        case 'Ks':
                                            return <td key={col} style={{ padding: '8px' }}>{Number(p.quantity).toLocaleString()}</td>;

                                        case 'Price':
                                        case 'Cena':
                                            return <td key={col} style={{ padding: '8px' }}>{p.markPrice}</td>;

                                        case 'Value':
                                        case 'Hodnota':
                                        case 'Hodnota $':
                                            return <td key={col} style={{ padding: '8px', fontWeight: 'bold' }}>{Number(p.marketValue || 0).toLocaleString()}</td>;

                                        case 'Hodnota CZK': {
                                            // marketValue × fxRateToBase = value in account base currency
                                            const baseVal = (p.marketValue || 0) * (p.fxRateToBase || 1);
                                            return <td key={col} style={{ padding: '8px', fontWeight: 'bold' }}>{baseVal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>;
                                        }

                                        case 'Avg Price': {
                                            const cost = p.costBasisPrice || p.costPrice;
                                            return <td key={col} style={{ padding: '8px' }}>{cost ? Number(cost).toLocaleString() : '-'}</td>;
                                        }

                                        case 'P/L': {
                                            const pnl = Number(p.unrealizedPnL || p.fifoPnlUnrealized || 0);
                                            const pnlColor = pnl > 0 ? '#4dff4d' : pnl < 0 ? '#ff4d4d' : '#888';
                                            return (
                                                <td key={col} style={{ padding: '8px', fontWeight: 'bold', color: pnlColor }}>
                                                    {pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })} {p.currency}
                                                </td>
                                            );
                                        }

                                        case 'Blokováno':
                                        case 'Blokováno $':
                                            return (
                                                <td key={col} style={{ padding: '8px', fontFamily: 'monospace', color: '#ccc' }}>
                                                    {p.commitedCapital ? Number(p.commitedCapital).toLocaleString() : '-'}
                                                </td>
                                            );

                                        case 'Blokováno CZK': {
                                            const baseVal = (p.commitedCapital || 0) * (p.fxRateToBase || 1);
                                            return (
                                                <td key={col} style={{ padding: '8px', fontFamily: 'monospace', color: '#ccc', fontWeight: 'bold' }}>
                                                    {p.commitedCapital ? baseVal.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
                                                </td>
                                            );
                                        }

                                        case 'Cost Basis':
                                            return <td key={col} style={{ padding: '8px' }}>{Number(p.costPrice || 0).toFixed(2)}</td>;

                                        case '%': {
                                            const rawCommit = p.commitedCapital;
                                            const netCommit = (p as any).netCommitedCapital;
                                            const hedgedQty = (p as any).hedgedQty ?? 0;
                                            const isHedged = typeof netCommit === 'number' && hedgedQty > 0;

                                            // Use net committed capital for % if available, else fall back
                                            const valForPct = isHedged
                                                ? netCommit * (p.fxRateToBase || 1)
                                                : (rawCommit ? rawCommit * (p.fxRateToBase || 1) : (p.marketValue || 0) * (p.fxRateToBase || 1));
                                            const netPct = netLiquidation ? (Math.abs(valForPct) / netLiquidation * 100).toFixed(2) : '0.00';

                                            const rawForTooltip = rawCommit
                                                ? (rawCommit * (p.fxRateToBase || 1) / netLiquidation * 100).toFixed(2)
                                                : null;

                                            const tooltipText = isHedged && rawForTooltip
                                                ? `Bez zajištění: ${rawForTooltip}%\nZajištěno ${hedgedQty} kontrakt${hedgedQty > 1 ? 'y' : ''} Long PUT\nEfektivní využití kapitálu: ${netPct}%`
                                                : null;

                                            return (
                                                <td key={col} style={{ padding: '8px', opacity: 0.85 }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', position: 'relative' }}>
                                                        <span style={{ color: isHedged ? '#4ade80' : undefined }}>
                                                            {Number(netPct) > 0.05 ? `${netPct}%` : '0%'}
                                                        </span>
                                                        {tooltipText && (
                                                            <span style={{ position: 'relative', display: 'inline-flex' }}>
                                                                <span style={{
                                                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                                    width: '16px', height: '16px', borderRadius: '50%',
                                                                    background: '#3b82f6', color: '#fff',
                                                                    fontSize: '0.7rem', fontWeight: 700, cursor: 'help',
                                                                    flexShrink: 0, lineHeight: 1,
                                                                }} className="tooltip-trigger">i</span>
                                                                <span className="tooltip-box" style={{
                                                                    position: 'absolute', bottom: '120%', left: '50%',
                                                                    transform: 'translateX(-50%)',
                                                                    background: '#1e293b', border: '1px solid #334155',
                                                                    borderRadius: '8px', padding: '8px 12px',
                                                                    fontSize: '0.78rem', lineHeight: '1.5',
                                                                    whiteSpace: 'pre', color: '#f1f5f9',
                                                                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                                                                    pointerEvents: 'none', zIndex: 100,
                                                                    minWidth: '220px',
                                                                }}>
                                                                    {tooltipText}
                                                                </span>
                                                            </span>
                                                        )}
                                                    </span>
                                                </td>
                                            );

                                        }


                                        default:
                                            return <td key={col}></td>;
                                    }
                                })}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
