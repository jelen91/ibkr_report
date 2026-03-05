'use client';

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface CapitalAllocationChartProps {
    stockValue: number;
    optionBlocked: number;
    longOptionValue: number;
    cryptoValue: number;
    futuresValue: number;
    freeCash: number;
    total: number;
    currency: 'CZK' | 'EUR';
    eurToCzkRate: number;
}

export default function CapitalAllocationChart({ stockValue, optionBlocked, longOptionValue, cryptoValue, futuresValue, freeCash, total, currency, eurToCzkRate }: CapitalAllocationChartProps) {
    const convert = (czk: number) => currency === 'EUR' ? czk / eurToCzkRate : czk;

    const data = [
        { name: 'Akcie (Long)', value: convert(stockValue), color: '#27ae60' },
        { name: 'Krypto (Long)', value: convert(cryptoValue), color: '#f1c40f' },
        { name: 'Futures', value: convert(futuresValue), color: '#9b59b6' },
        { name: 'Opce (Long)', value: convert(longOptionValue), color: '#e67e22' },
        { name: 'Blokováno (Short Puts)', value: convert(Math.abs(optionBlocked)), color: '#e74c3c' },
        { name: 'Volná Hotovost', value: convert(freeCash), color: '#3498db' },
    ].filter(item => (item.value || 0) > 0);

    const formatCurrency = (val: number) => {
        return Number(val).toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + ' ' + currency;
    };

    const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
        const RADIAN = Math.PI / 180;
        const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
        const x = cx + radius * Math.cos(-midAngle * RADIAN);
        const y = cy + radius * Math.sin(-midAngle * RADIAN);

        if (percent < 0.05) return null;

        return (
            <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" style={{ fontSize: '12px', fontWeight: 'bold', textShadow: '1px 1px 2px black' }}>
                {`${(percent * 100).toFixed(0)}%`}
            </text>
        );
    };

    return (
        <div className="card chart-card">
            <h3 style={{ marginBottom: '1rem', flexShrink: 0 }}>Alokace Kapitálu</h3>
            <div style={{ width: '100%', flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={data}
                            cx="45%"
                            cy="50%"
                            labelLine={false}
                            label={renderCustomLabel}
                            outerRadius="75%"
                            fill="#8884d8"
                            dataKey="value"
                        >
                            {data.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                            ))}
                        </Pie>
                        <Tooltip
                            formatter={(value: any) => formatCurrency(value)}
                            contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #444', color: '#f1f5f9' }}
                            itemStyle={{ color: '#f1f5f9' }}
                        />
                        <Legend layout="vertical" verticalAlign="middle" align="left" wrapperStyle={{ left: 0, top: '0', bottom: '0', display: 'flex', flexDirection: 'column', justifyContent: 'center' }} />
                    </PieChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
