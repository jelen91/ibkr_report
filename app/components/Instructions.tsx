import Image from 'next/image';

export default function Instructions() {
    const steps = [
        {
            text: "V rozhraní IBKR klikněte na Performance & Reports",
            image: "/images/guide/1.png", width: 2348, height: 440
        },
        {
            text: "Zvolte Flex Queries",
            image: "/images/guide/2.png", width: 608, height: 802
        },
        {
            text: "Kliněte na ikonu ozubeného kola (Configure) u Flex Web Service Configuration",
            image: "/images/guide/3.png", width: 2848, height: 1518
        },
        {
            text: "Vygenerujte nový token a uložte si ho (Current Token)",
            image: "/images/guide/4.png", width: 2792, height: 1150
        },
        {
            text: "Vraťte se zpět a vytvořte Activity Flex Query (Create new)",
            image: "/images/guide/5.png", width: 2848, height: 1496
        },
        {
            text: "Pro portfolio zapněte Account Information, Net Asset Value (NAV) in Base, Cash Report a Open Positions (SUMMARY; včetně Currency, FX Rate to Base, Multiplier, Value a Unrealized P/L). Pro výkonnost nastavte Last 365 Calendar Days a přidejte Statement of Funds, Trades a Conversion Rates. Použijte datum YYYYMMDD.",
            image: "/images/guide/6.png", width: 2654, height: 1404
        },
        {
            text: "Dole v nastavení Models zvolte Optional a zaškrtněte 'Include Currency Rates'",
            image: "/images/guide/7.png", width: 2904, height: 1636
        },
        {
            text: "Klikněte na Continue a uložte si Query ID",
            image: "/images/guide/8.png", width: 2870, height: 1644
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
                            <Image
                                src={step.image}
                                width={step.width}
                                height={step.height}
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
