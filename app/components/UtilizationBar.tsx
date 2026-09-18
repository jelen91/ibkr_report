'use client';

interface UtilizationBarProps {
    invested: number;
    total: number;
    complete?: boolean;
}

export default function UtilizationBar({ invested, total, complete = true }: UtilizationBarProps) {
    const rawPercentage = complete && total > 0 ? (invested / total) * 100 : NaN;
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;
    const barWidth = Math.min(100, Math.max(0, percentage));

    const color = '#2fa061';

    return (
        <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'flex-end' }}>
                <h3 style={{ margin: 0 }}>Expozice / AUM</h3>
                <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: color }}>{complete && total > 0 ? `${percentage.toLocaleString('cs-CZ', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %` : '—'}</span>
                </div>
            </div>

            {/* Progress Bar Container */}
            <div style={{
                height: '24px',
                backgroundColor: '#334155',
                borderRadius: '12px',
                overflow: 'hidden',
                position: 'relative'
            }}>
                {/* Fill */}
                <div style={{
                    width: `${barWidth}%`,
                    height: '100%',
                    backgroundColor: color,
                    transition: 'width 0.5s ease-in-out, background-color 0.5s'
                }} />

            </div>
        </div>
    );
}
