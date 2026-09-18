import { useState } from 'react';
import type { PositionItem } from '../types';
import { parseExpiryDate, formatDate } from '../utils/formatting';

interface PositionCategoryProps {
    title: string;
    data: PositionItem[];
    columns: string[];
    color: string;
    netLiquidation: number;
    acctBaseCurrency: string;
}

export default function PositionCategory({ title, data, columns, color, netLiquidation, acctBaseCurrency }: PositionCategoryProps) {
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
    if (!data.length) return null;
    const fmt = (value: number | undefined, currency?: string) => value === undefined || !Number.isFinite(value)
        ? '—' : `${value.toLocaleString('cs-CZ', { maximumFractionDigits: 8 })}${currency ? ` ${currency}` : ''}`;
    const commitment = (item: PositionItem) => item.value.netCommitedCapital ?? item.value.commitedCapital;
    const percent = (item: PositionItem) => netLiquidation > 0
        ? (commitment(item) ?? item.value.marketValue) * (item.value.fxRateToBase ?? 1) / netLiquidation * 100 : undefined;
    const pnl = (item: PositionItem) => item.value.fifoPnlUnrealized ?? item.value.unrealizedPnL;
    const label = (col: string) => ({
        'Hodnota $': 'Hodnota (měna pozice)', 'Hodnota CZK': `Hodnota ${acctBaseCurrency}`,
        'Blokováno $': 'Závazek PUT (měna pozice)', 'Blokováno CZK': `Závazek PUT ${acctBaseCurrency}`,
        'P/L': 'Nerealizované P/L', '%': '% NAV',
    }[col] ?? col);
    const sortValue = (item: PositionItem, col: string): number | string => {
        const p = item.value;
        switch (col) {
            case 'Účet': return p.accountName ?? p.accountId ?? '';
            case 'Ticker': return p.underlying ?? p.symbol;
            case 'Expirace': return parseExpiryDate(p.expiry) || Infinity;
            case 'Strike': return p.strike ?? 0;
            case 'Typ': return p.type ?? '';
            case 'Ks': return p.quantity;
            case 'Cena': case 'Price': return p.markPrice;
            case 'Hodnota $': case 'Hodnota': case 'Value': return p.marketValue;
            case 'Hodnota CZK': return p.marketValue * (p.fxRateToBase ?? 1);
            case 'Blokováno $': case 'Blokováno': return commitment(item) ?? 0;
            case 'Blokováno CZK': return (commitment(item) ?? 0) * (p.fxRateToBase ?? 1);
            case 'Avg Price': case 'Cost Basis': return p.costBasisPrice ?? p.costPrice ?? 0;
            case 'P/L': return pnl(item) ?? -Infinity;
            case '%': return percent(item) ?? -Infinity;
            default: return '';
        }
    };
    const sorted = [...data].sort((a, b) => {
        if (!sortConfig) return 0;
        const av = sortValue(a, sortConfig.key), bv = sortValue(b, sortConfig.key);
        return (av < bv ? -1 : av > bv ? 1 : 0) * (sortConfig.direction === 'asc' ? 1 : -1);
    });
    return <div className="card" style={{ marginBottom: '1rem', overflowX: 'auto', borderTop: `4px solid ${color}` }}>
        <h3 style={{ margin: '0 0 1rem' }}>{title}</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', color: '#eee' }}>
            <thead><tr style={{ borderBottom: '1px solid #444', textAlign: 'left', opacity: 0.7 }}>
                {columns.map(col => <th key={col} style={{ padding: 8, cursor: 'pointer' }} onClick={() => setSortConfig({ key: col, direction: sortConfig?.key === col && sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>
                    {label(col)} {sortConfig?.key === col ? (sortConfig.direction === 'asc' ? '▲' : '▼') : ''}
                </th>)}
            </tr></thead>
            <tbody>{sorted.map((item, index) => {
                const p = item.value;
                const content = (col: string) => {
                    switch (col) {
                        case 'Účet': return p.accountName ?? p.accountId ?? '—';
                        case 'Ticker': return <strong>{p.underlying ?? p.symbol}</strong>;
                        case 'Expirace': return p.expiry ? formatDate(String(p.expiry)) : '—';
                        case 'Strike': return fmt(p.strike, item.currency);
                        case 'Typ': return p.type ?? '—';
                        case 'Asset': return p.assetClass;
                        case 'Ks': return fmt(p.quantity);
                        case 'Cena': case 'Price': return fmt(p.markPrice, item.currency);
                        case 'Hodnota': case 'Hodnota $': case 'Value': return fmt(p.marketValue, item.currency);
                        case 'Hodnota CZK': return fmt(p.marketValue * (p.fxRateToBase ?? 1));
                        case 'Avg Price': case 'Cost Basis': return fmt(p.costBasisPrice ?? p.costPrice, item.currency);
                        case 'P/L': {
                            const value = pnl(item);
                            return <span style={{ color: value === undefined ? '#94a3b8' : value > 0 ? '#4ade80' : value < 0 ? '#f87171' : undefined }}>{fmt(value, item.currency)}</span>;
                        }
                        case 'Blokováno': case 'Blokováno $': return fmt(commitment(item), item.currency);
                        case 'Blokováno CZK': return fmt(commitment(item) === undefined ? undefined : commitment(item)! * (p.fxRateToBase ?? 1));
                        case '%': {
                            const value = percent(item);
                            return <span title={(p.hedgedQty ?? 0) > 0 ? `Zajištěno ${p.hedgedQty} kontraktů PUT se stejnou expirací. Závazek před zajištěním: ${fmt(p.commitedCapital, item.currency)}. Nejde o marži.` : undefined}>
                                {value === undefined ? '—' : `${value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`}{(p.hedgedQty ?? 0) > 0 ? ' ⓘ' : ''}
                            </span>;
                        }
                        default: return '—';
                    }
                };
                return <tr key={`${p.accountId}:${p.conid ?? p.symbol}:${index}`} style={{ borderBottom: '1px solid #222' }}>
                    {columns.map(col => <td key={col} style={{ padding: 8, whiteSpace: 'nowrap' }}>{content(col)}</td>)}
                </tr>;
            })}</tbody>
        </table>
    </div>;
}
