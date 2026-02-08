import { useState } from 'react';

interface CredentialsFormProps {
    onConnect: (token: string, queryId: string, remember: boolean) => void;
    loading?: boolean;
}

export default function CredentialsForm({ onConnect, loading }: CredentialsFormProps) {
    const [token, setToken] = useState('');
    const [queryId, setQueryId] = useState('');
    const [remember, setRemember] = useState(false);

    // If already saved in localStorage, these will be populated by parent or we could check here.
    // But let's keep it simple: input fields.

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (token && queryId) {
            onConnect(token, queryId, remember);
        }
    };

    return (
        <div className="card" style={{ maxWidth: '600px', margin: '2rem auto' }}>
            <h3>Připojení k IBKR Flex</h3>
            <p style={{ fontSize: '0.9rem', opacity: 0.8, marginBottom: '1.5rem' }}>
                Zadejte svůj Flex Token a Query ID pro zobrazení portfolia.
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Flex Token</label>
                    <input
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            borderRadius: '4px',
                            border: '1px solid #444',
                            background: '#222',
                            color: '#fff',
                            boxSizing: 'border-box'
                        }}
                        placeholder="Vložte váš Flex Token"
                        required
                    />
                </div>

                <div>
                    <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Query ID</label>
                    <input
                        type="text"
                        value={queryId}
                        onChange={(e) => setQueryId(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '0.75rem',
                            borderRadius: '4px',
                            border: '1px solid #444',
                            background: '#222',
                            color: '#fff',
                            boxSizing: 'border-box'
                        }}
                        placeholder="Vložte Query ID"
                        required
                    />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                        type="checkbox"
                        id="remember"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        style={{ width: '16px', height: '16px' }}
                    />
                    <label htmlFor="remember" style={{ fontSize: '0.9rem', cursor: 'pointer' }}>Zapamatovat si mě (uložit do prohlížeče)</label>
                </div>

                <button
                    type="submit"
                    disabled={loading}
                    style={{
                        marginTop: '1rem',
                        padding: '0.75rem',
                        background: 'var(--primary-color, #3498db)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: loading ? 'not-allowed' : 'pointer',
                        opacity: loading ? 0.7 : 1,
                        fontWeight: 'bold'
                    }}
                >
                    {loading ? 'Načítání...' : 'Načíst Data'}
                </button>
            </form>
        </div>
    );
}
