import { useState } from 'react';
import Image from 'next/image';

export default function Instructions() {
    const steps = [
        {
            text: "V rozhraní IBKR klikněte na Performance & Reports",
            image: "/images/guide/1.png"
        },
        {
            text: "Zvolte Flex Queries",
            image: "/images/guide/2.png"
        },
        {
            text: "Kliněte na ikonu ozubeného kola (Configure) u Flex Web Service Configuration",
            image: "/images/guide/3.png"
        },
        {
            text: "Vygenerujte nový token a uložte si ho (Current Token)",
            image: "/images/guide/4.png"
        },
        {
            text: "Vraťte se zpět a vytvořte Activity Flex Query (Create new)",
            image: "/images/guide/5.png"
        },
        {
            text: "V nastavení reportu vyberte v sekci Sections položky 'Net Asset Value' a 'Open Positions' (vybrat všechny sloupce Select All)",
            image: "/images/guide/6.png"
        },
        {
            text: "Dole v nastavení zaškrtněte 'Include Currency Rates'",
            image: "/images/guide/7.png"
        },
        {
            text: "Klikněte na Continue a uložte si Query ID",
            image: "/images/guide/8.png"
        }
    ];

    return (
        <div className="card" style={{ maxWidth: '800px', margin: '2rem auto', textAlign: 'left' }}>
            <h3 style={{ margin: '0 0 1rem 0' }}>Jak získat Flex Token a Query ID?</h3>
            <p style={{ opacity: 0.8, marginBottom: '1.5rem' }}>
                Tato aplikace slouží k přehlednému zobrazení XML reportu z vašeho IBKR portfolia.
                Report se aktualizuje typicky jednou denně.
                Pro zprovoznění potřebujete nastavit Flex Web Service a vytvořit Flex Query.
            </p>

            <div className="steps-container">
                {steps.map((step, index) => (
                    <div key={index} className="step" style={{ marginBottom: '2rem' }}>
                        <h4 style={{ marginBottom: '0.5rem' }}>{index + 1}. {step.text}</h4>
                        <div style={{ position: 'relative', width: '100%', borderRadius: '8px', overflow: 'hidden', border: '1px solid #444' }}>
                            <img
                                src={step.image}
                                alt={`Krok ${index + 1}`}
                                style={{ width: '100%', height: 'auto', display: 'block' }}
                            />
                        </div>
                    </div>
                ))}
            </div>

            <div style={{ marginTop: '1rem', padding: '1rem', background: '#333', borderRadius: '4px' }}>
                <p style={{ margin: 0 }}>
                    Po dokončení nastavení klikněte na <b>Save Changes</b> v IBKR.
                    Následně se můžete přihlásit zde pomocí vašeho <b>Tokenu</b> a <b>Query ID</b>.
                </p>
            </div>
        </div>
    );
}
