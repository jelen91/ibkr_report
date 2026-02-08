import { useState } from 'react';

interface PositionCategoryProps {
    title: string;
    data: any[];
    columns: string[];
    color: string;
    netLiquidation: number;
}

export default function PositionCategory({ title, data, columns, color, netLiquidation }: PositionCategoryProps) {
    const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);

    if (!data || data.length === 0) return null;

    const requestSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const getExpiryStyle = (expiry: string | number | undefined) => {
        if (!expiry) return {};
        let s = String(expiry);
        let diffDays = 0;

        let targetDate: Date | null = null;

        if (s.includes('.')) {
            // DD.MM.YYYY
            targetDate = new Date(s.split('.').reverse().join('-'));
        } else if (s.length === 8) {
            // YYYYMMDD
            targetDate = new Date(`${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`);
        }

        if (targetDate) {
            const today = new Date();
            const diffTime = targetDate.getTime() - today.getTime();
            diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }


        // Logic: Green -> Yellow -> Red
        let bgColor;
        let textColor = '#fff';

        if (diffDays <= 7) {
            bgColor = '#ff4d4d'; // Red
        } else if (diffDays <= 30) {
            bgColor = '#ffad33'; // Orange
            textColor = '#000';
        } else if (diffDays <= 60) {
            bgColor = '#ffff66'; // Yellow
            textColor = '#000';
        } else {
            bgColor = '#4dff4d'; // Green
            textColor = '#000';
        }

        return {
            backgroundColor: bgColor,
            color: textColor,
            padding: '2px 6px',
            borderRadius: '4px',
            fontWeight: 'bold'
        };
    };

    const formatExpiry = (val: string | number | undefined) => {
        if (!val) return '-';
        const s = String(val);
        if (!s.includes('.') && s.length === 8) {
            return `${s.substring(6, 8)}.${s.substring(4, 6)}.${s.substring(0, 4)}`;
        }
        return s;
    }

    const sortedData = [...data].sort((a, b) => {
        if (!sortConfig) return 0;

        const getValue = (item: any, col: string) => {
            const p = item.value;
            switch (col) {
                case 'Ticker': return p.underlying || p.symbol;
                case 'Expirace':
                    const s = String(p.expiry || '');
                    if (!s) return '99999999'; // Sort undefined/null to end
                    // Normalize to YYYYMMDD for sorting
                    if (s.includes('.')) return s.split('.').reverse().join('');
                    return s;
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
                case 'Cost Basis': return Number(p.costPrice || 0);
                case '%':
                    const valForPercent = p.commitedCapital ? p.commitedCapital : p.marketValue;
                    const valInBase = Math.abs(valForPercent) * (p.fxRateToBase || 1);
                    return netLiquidation ? (valInBase / netLiquidation) : 0;
                default: return '';
            }
        };

        const valA = getValue(a, sortConfig.key);
        const valB = getValue(b, sortConfig.key); // Fix variable name

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
                                {c} {sortConfig?.key === c ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sortedData.map((item, idx) => {
                        const p = item.value;
                        // Calculate % for "Hodnota" (Commited Capital) or "Value" (Market Value) depending on context
                        const valForPercent = p.commitedCapital ? p.commitedCapital : p.marketValue;

                        // Convert to Base Currency using FX Rate (if available)
                        const valInBase = Math.abs(valForPercent) * (p.fxRateToBase || 1);

                        const percent = netLiquidation ? (valInBase / netLiquidation * 100).toFixed(2) : '0.00';

                        return (
                            <tr key={idx} style={{ borderBottom: '1px solid #222' }}>
                                {columns.map(col => {
                                    switch (col) {
                                        case 'Ticker':
                                            return <td key={col} style={{ padding: '8px', fontWeight: 'bold' }}>{p.underlying || p.symbol}</td>;

                                        case 'Expirace':
                                            return (
                                                <td key={col} style={{ padding: '8px' }}>
                                                    <span style={getExpiryStyle(p.expiry)}>
                                                        {formatExpiry(p.expiry)}
                                                    </span>
                                                </td>
                                            );

                                        case 'Strike':
                                            return <td key={col} style={{ padding: '8px' }}>{p.strike || '-'}</td>;

                                        case 'Typ':
                                            return (
                                                <td key={col} style={{ padding: '8px' }}>
                                                    <span style={{
                                                        padding: '2px 6px',
                                                        borderRadius: '4px',
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

                                        case 'Hodnota CZK':
                                            const valCZK = (p.marketValue || 0) * (p.fxRateToBase || 1);
                                            return <td key={col} style={{ padding: '8px', fontWeight: 'bold' }}>{valCZK.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>;

                                        case 'Blokováno':
                                        case 'Blokováno $':
                                            return (
                                                <td key={col} style={{ padding: '8px', fontFamily: 'monospace', color: '#ccc' }}>
                                                    {p.commitedCapital ? Number(p.commitedCapital).toLocaleString() : '-'}
                                                </td>
                                            );

                                        case 'Blokováno CZK':
                                            const blockedCZK = (p.commitedCapital || 0) * (p.fxRateToBase || 1);
                                            return (
                                                <td key={col} style={{ padding: '8px', fontFamily: 'monospace', color: '#ccc', fontWeight: 'bold' }}>
                                                    {p.commitedCapital ? blockedCZK.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}
                                                </td>
                                            );

                                        case 'Cost Basis':
                                            return <td key={col} style={{ padding: '8px' }}>{Number(p.costPrice || 0).toFixed(2)}</td>;

                                        case '%':
                                            return (
                                                <td key={col} style={{ padding: '8px', opacity: 0.7 }}>
                                                    {Number(percent) > 0.05 ? `${percent}%` : ''}
                                                </td>
                                            );

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
