'use client';

interface UtilizationBarProps {
    invested: number;
    total: number;
}

export default function UtilizationBar({ invested, total }: UtilizationBarProps) {
    const rawPercentage = (invested / total) * 100;
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;
    const barWidth = Math.min(100, Math.max(0, percentage));

    let color = '#2fa061'; // Green

    if (percentage > 90) {
        color = '#ef4444'; // Red
    } else if (percentage > 70) {
        color = '#f59e0b'; // Orange
    }

    return (
        <div className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'flex-end' }}>
                <h3 style={{ margin: 0 }}>Využití Kapitálu</h3>
                <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: color }}>{percentage.toFixed(1)}%</span>
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

                {/* Markers for 70% and 90% */}
                <div style={{ position: 'absolute', left: '70%', top: 0, bottom: 0, width: '2px', backgroundColor: 'rgba(255,255,255,0.3)' }} title="70% Warning" />
                <div style={{ position: 'absolute', left: '90%', top: 0, bottom: 0, width: '2px', backgroundColor: 'rgba(255,255,255,0.3)' }} title="90% Danger" />
            </div>
        </div>
    );
}
