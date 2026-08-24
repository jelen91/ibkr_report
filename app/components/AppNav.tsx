'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
    { href: '/', label: 'Portfolio IBKR' },
    { href: '/performance', label: 'Výkonnost vs. index' },
    { href: '/overview', label: 'Celkový majetek' },
];

export default function AppNav() {
    const pathname = usePathname() || '/';

    return (
        <nav style={{
            display: 'flex',
            gap: '0.25rem',
            padding: '0.6rem 2rem 0',
            borderBottom: '1px solid #1e293b',
            overflowX: 'auto',
        }}>
            {TABS.map(tab => {
                // "/" je aktivní jen přesně, ostatní i pro případné podstránky
                const active = tab.href === '/'
                    ? pathname === '/'
                    : pathname.startsWith(tab.href);

                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        style={{
                            padding: '0.55rem 1rem',
                            fontSize: '0.85rem',
                            fontWeight: active ? 700 : 500,
                            color: active ? '#f1f5f9' : '#64748b',
                            textDecoration: 'none',
                            whiteSpace: 'nowrap',
                            borderBottom: `2px solid ${active ? '#3b82f6' : 'transparent'}`,
                            marginBottom: '-1px',
                        }}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
