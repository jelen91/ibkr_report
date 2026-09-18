import { useState } from 'react';

interface CredentialsFormProps {
    onConnect: (name: string, token: string, queryId: string) => void;
    loading?: boolean;
    compact?: boolean;
}

export default function CredentialsForm({ onConnect, loading, compact }: CredentialsFormProps) {
    const [name, setName] = useState('');
    const [token, setToken] = useState('');
    const [queryId, setQueryId] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (token.trim() && queryId.trim()) {
            onConnect(name.trim() || 'Účet', token.trim(), queryId.trim());
        }
    };

    const inputStyle: React.CSSProperties = {
        width: '100%',
        padding: '0.6rem',
        borderRadius: '4px',
        border: '1px solid #444',
        background: '#222',
        color: '#fff',
        boxSizing: 'border-box',
        fontSize: '0.9rem',
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        marginBottom: '0.3rem',
        fontSize: '0.8rem',
        opacity: 0.7,
    };

    return (
        <div className={compact ? undefined : 'card'} style={compact ? { background: '#0f172a', border: '1px solid #334155', borderRadius: '10px', padding: '1rem' } : { maxWidth: '600px', margin: '2rem auto' }}>
            {!compact && (
                <>
                    <h3>Připojení k IBKR Flex</h3>
                    <p style={{ fontSize: '0.9rem', opacity: 0.8, marginBottom: '1.5rem' }}>
                        Zadejte Flex Token a Query ID pro zobrazení portfolia.
                    </p>
                </>
            )}
            {compact && <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', color: '#94a3b8' }}>Přidat účet</div>}

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: compact ? 'row' : 'column', gap: '0.6rem', flexWrap: 'wrap', alignItems: compact ? 'flex-end' : 'stretch' }}>
                <div style={{ flex: compact ? '1 1 120px' : undefined }}>
                    <label style={labelStyle}>Název účtu</label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        style={inputStyle}
                        placeholder="např. Jelen"
                    />
                </div>

                <div style={{ flex: compact ? '2 1 180px' : undefined }}>
                    <label style={labelStyle}>Flex Token</label>
                    <input
                        type="password"
                        value={token}
                        onChange={e => setToken(e.target.value)}
                        style={inputStyle}
                        placeholder="Flex Token"
                        required
                    />
                </div>

                <div style={{ flex: compact ? '1 1 120px' : undefined }}>
                    <label style={labelStyle}>Query ID</label>
                    <input
                        type="text"
                        value={queryId}
                        onChange={e => setQueryId(e.target.value)}
                        style={inputStyle}
                        placeholder="Query ID"
                        required
                    />
                </div>

                <button
                    type="submit"
                    disabled={loading}
                    style={{
                        padding: compact ? '0.6rem 1rem' : '0.75rem',
                        background: '#3b82f6',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        opacity: loading ? 0.7 : 1,
                        fontWeight: 'bold',
                        whiteSpace: 'nowrap',
                        flex: compact ? '0 0 auto' : undefined,
                        alignSelf: compact ? 'flex-end' : undefined,
                    }}
                >
                    {loading ? 'Načítání…' : compact ? 'Přidat' : 'Načíst Data'}
                </button>
            </form>
        </div>
    );
}
