// Odhad české daně z investic — model pro srovnání "aktivní trading vs. držení indexu".
//
// Není to daňové přiznání a nenahrazuje daňaře: pár věcí flex query neumí dodat
// (viz `unknownHoldingPnl` níž) a některá pravidla mají výklady. Cílem je
// kvantifikovat hlavní ekonomický rozdíl mezi obchodováním a držením:
//
//   • Akcie prodané po 3 letech držení jsou osvobozené (časový test, §4 odst. 1 písm. x).
//   • Akcie jsou osvobozené i tehdy, když úhrn hrubých prodejů za rok nepřesáhne
//     100 000 Kč (hodnotový test).
//   • Deriváty (opce, futures) žádný z těchto testů nemají — daní se vždy.
//     Právě to je u opčního tradingu ta podstatná nevýhoda proti držení ETF.
//   • Ztrátu z jednoho druhu příjmu nelze uplatnit proti jinému druhu ani ji
//     převést do dalších let — každý koš se proto zvlášť ořízne na nulu.
//   • Dividendy a úroky jsou §8; sražená zahraniční daň se započítává, ale jen
//     do výše české daně z téhož příjmu.

export type TaxBucketKey = 'securities' | 'derivatives' | 'crypto' | 'other';

export interface RealizedTrade {
    date: string;            // YYYYMMDD, den obchodu
    assetCategory: string;   // STK / OPT / FUT / CASH / CRYPTO …
    pnl: number;             // realizovaný zisk/ztráta v bázové měně
    proceeds: number;        // hrubý příjem z prodeje v bázové měně (0 u nákupů)
    holdingDays: number | null; // null = dobu držení se nepodařilo dohledat
}

export interface CashItem {
    date: string;
    amount: number;
}

export interface TaxInputs {
    trades: RealizedTrade[];
    unrealized: RealizedTrade[];  // otevřené pozice k poslednímu dni reportu
    dividends: CashItem[];        // DIV, hrubé
    dividendWithheld: CashItem[]; // FRTAX u dividend (záporné = sraženo)
    interest: CashItem[];         // CINT (kladné) a DINT (záporné)
    interestWithheld: CashItem[]; // FRTAX u úroků
}

export type RateMode = 'fixed15' | 'fixed23' | 'auto';

export interface TaxSettings {
    rateMode: RateMode;
    timeTestDays: number;   // 3 roky
    valueTestLimit: number; // 100 000 Kč hrubých prodejů CP za rok
    // Sazba 23 % se neuplatní na investice zvlášť — vztahuje se na součet všech
    // dílčích základů (§6 zaměstnání, §7 podnikání, §8, §9, §10). U OSVČ tedy
    // o marginální sazbě z obchodování rozhoduje hlavně zisk z podnikání, který
    // "zaplní" pásmo pod hranicí.
    otherTaxBase: number;          // ostatní dílčí základy za rok (typicky zisk OSVČ)
    progressiveThreshold: number;  // 36násobek průměrné mzdy
    // Scénář "prodám dnes všechno": zdaní i nerealizované zisky. Musí platit pro
    // obě strany srovnání zároveň, jinak by index vycházel uměle líp.
    liquidate: boolean;
}

export const LOWER_RATE = 0.15;
export const UPPER_RATE = 0.23;

// Stropy výdajových paušálů OSVČ (§7 odst. 7) — procento se počítá nejvýš
// z příjmů 2 000 000 Kč, takže absolutní výše odpočtu je zastropovaná.
export const EXPENSE_LUMP_CAPS: Record<string, number> = {
    '0.8': 1600000,
    '0.6': 1200000,
    '0.4': 800000,
    '0.3': 600000,
};

/**
 * Dílčí základ §7 při uplatnění výdajového paušálu. Právě tenhle základ
 * "zaplní" pásmo pod hranicí progrese dřív, než se na něj dostanou zisky
 * z obchodování — u OSVČ proto o sazbě z tradingu rozhoduje hlavně on.
 *
 * Pozn.: příjmy z §8 a §10 nevstupují do vyměřovacích základů sociálního
 * a zdravotního pojištění, na rozdíl od §7. Zisk z obchodování tedy zvyšuje
 * jen daň, ne odvody.
 */
export function selfEmployedTaxBase(income: number, expenseRate: number): number {
    if (income <= 0) return 0;
    const cap = EXPENSE_LUMP_CAPS[String(expenseRate)] ?? income * expenseRate;
    return Math.max(0, income - Math.min(income * expenseRate, cap));
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
    rateMode: 'fixed15',
    timeTestDays: 1095,
    valueTestLimit: 100000,
    otherTaxBase: 0,
    progressiveThreshold: 1730000,
    liquidate: false,
};

/**
 * Efektivní sazba na investiční základ. V režimu `auto` se investiční základ
 * "naskládá" nad ostatní dílčí základy a rozdělí se na část pod hranicí (15 %)
 * a nad hranicí (23 %) — což je způsob, jakým progrese reálně funguje.
 */
export function effectiveRate(investmentBase: number, settings: TaxSettings): number {
    if (settings.rateMode === 'fixed15') return LOWER_RATE;
    if (settings.rateMode === 'fixed23') return UPPER_RATE;
    if (investmentBase <= 0) return LOWER_RATE;

    const room = Math.max(0, settings.progressiveThreshold - settings.otherTaxBase);
    const lower = Math.min(investmentBase, room);
    const upper = investmentBase - lower;
    return (lower * LOWER_RATE + upper * UPPER_RATE) / investmentBase;
}

export interface BucketResult {
    gain: number;           // zisk/ztráta v koši (po vyloučení osvobozených)
    exemptGain: number;     // zisk osvobozený testem
    proceeds: number;       // hrubé prodeje (jen u cenných papírů a krypta)
    taxable: number;        // základ daně (ztráta oříznutá na 0)
    tax: number;
    valueTestApplied: boolean;
}

export interface IncomeResult {
    gross: number;          // jen kladné příjmy
    nonDeductible: number;  // zaplacené (debetní) úroky — u §8 se odečíst nedají
    withheld: number;       // kladné číslo = kolik už bylo sraženo v zahraničí
    credit: number;         // uznaný zápočet
    tax: number;            // doplatek v ČR po zápočtu
}

export interface TaxYearResult {
    year: string;
    buckets: Record<TaxBucketKey, BucketResult>;
    dividends: IncomeResult;
    interest: IncomeResult;
    totalTax: number;
    unknownHoldingPnl: number; // zisk, u kterého nešlo ověřit časový test
    rate: number;              // efektivní sazba použitá v tomto roce
    investmentBase: number;    // součet zdanitelných investičních základů
    grossIncome: number;       // hrubé příjmy §8+§10 (kvůli limitu paušálního režimu)
}

const BUCKET_OF: Record<string, TaxBucketKey> = {
    STK: 'securities',
    FUND: 'securities',
    BOND: 'securities',
    OPT: 'derivatives',
    FUT: 'derivatives',
    FOP: 'derivatives',
    CFD: 'derivatives',
    CRYPTO: 'crypto',
};

const bucketOf = (assetCategory: string): TaxBucketKey =>
    BUCKET_OF[assetCategory?.toUpperCase()] ?? 'other';

// Časový i hodnotový test má jen koš cenných papírů a krypto.
const HAS_TESTS: Record<TaxBucketKey, boolean> = {
    securities: true,
    crypto: true,
    derivatives: false,
    other: false,
};

const emptyBucket = (): BucketResult => ({
    gain: 0, exemptGain: 0, proceeds: 0, taxable: 0, tax: 0, valueTestApplied: false,
});

const yearOf = (ymd: string) => ymd.slice(0, 4);

/**
 * Spočítá daňovou povinnost po jednotlivých kalendářních letech.
 * `upToDate` umožňuje průběžný výpočet pro graf — bere se jen to, co se do
 * daného dne stihlo realizovat.
 */
export function computeTax(
    inputs: TaxInputs,
    settings: TaxSettings,
    upToDate?: string,
): TaxYearResult[] {
    const within = (d: string) => !upToDate || d <= upToDate;
    const years = new Map<string, TaxYearResult>();

    const yearFor = (ymd: string): TaxYearResult => {
        const y = yearOf(ymd);
        let r = years.get(y);
        if (!r) {
            r = {
                year: y,
                buckets: {
                    securities: emptyBucket(),
                    derivatives: emptyBucket(),
                    crypto: emptyBucket(),
                    other: emptyBucket(),
                },
                dividends: { gross: 0, nonDeductible: 0, withheld: 0, credit: 0, tax: 0 },
                interest: { gross: 0, nonDeductible: 0, withheld: 0, credit: 0, tax: 0 },
                totalTax: 0,
                unknownHoldingPnl: 0,
                rate: LOWER_RATE,
                investmentBase: 0,
                grossIncome: 0,
            };
            years.set(y, r);
        }
        return r;
    };

    // ── §10: realizované obchody (a při likvidaci i otevřené pozice) ──
    const positions = settings.liquidate
        ? [...inputs.trades, ...inputs.unrealized]
        : inputs.trades;

    for (const t of positions) {
        if (!within(t.date)) continue;
        const year = yearFor(t.date);
        const key = bucketOf(t.assetCategory);
        const b = year.buckets[key];

        const exemptByTime =
            HAS_TESTS[key] && t.holdingDays !== null && t.holdingDays >= settings.timeTestDays;

        if (exemptByTime) {
            b.exemptGain += t.pnl;
            continue; // osvobozený prodej se nezapočítává ani do limitu 100 000 Kč
        }

        b.gain += t.pnl;
        b.proceeds += t.proceeds;
        year.grossIncome += t.proceeds;

        if (HAS_TESTS[key] && t.holdingDays === null && t.pnl > 0) {
            year.unknownHoldingPnl += t.pnl;
        }
    }

    // ── §8: dividendy a úroky ──
    // Do základu jde jen kladný příjem. Debetní úroky (DINT) jsou u fyzické
    // osoby nedaňový výdaj — základ nesnižují, jen se ukážou pro úplnost.
    const addIncome = (r: IncomeResult, amount: number) => {
        if (amount >= 0) r.gross += amount;
        else r.nonDeductible += -amount;
    };

    for (const d of inputs.dividends) if (within(d.date)) {
        const y = yearFor(d.date);
        addIncome(y.dividends, d.amount);
        if (d.amount > 0) y.grossIncome += d.amount;
    }
    for (const w of inputs.dividendWithheld) if (within(w.date)) yearFor(w.date).dividends.withheld += -w.amount;
    for (const i of inputs.interest) if (within(i.date)) {
        const y = yearFor(i.date);
        addIncome(y.interest, i.amount);
        if (i.amount > 0) y.grossIncome += i.amount;
    }
    for (const w of inputs.interestWithheld) if (within(w.date)) yearFor(w.date).interest.withheld += -w.amount;

    // ── uzavření roku ──
    for (const year of years.values()) {
        for (const key of Object.keys(year.buckets) as TaxBucketKey[]) {
            const b = year.buckets[key];

            // Hodnotový test: nepřesáhly-li hrubé prodeje limit, je celý koš osvobozený.
            if (HAS_TESTS[key] && b.proceeds > 0 && b.proceeds <= settings.valueTestLimit) {
                b.valueTestApplied = true;
                b.exemptGain += b.gain;
                b.gain = 0;
            }

            // Ztrátu nelze uplatnit proti jinému druhu příjmu ani přenést do dalších let.
            b.taxable = Math.max(0, b.gain);
        }

        // Sazba se určuje až ze součtu všech investičních základů — jednotlivé
        // koše nemají vlastní pásmo.
        const investmentBase =
            Object.values(year.buckets).reduce((s, b) => s + b.taxable, 0) +
            Math.max(0, year.dividends.gross) +
            Math.max(0, year.interest.gross);

        const rate = effectiveRate(investmentBase, settings);
        year.rate = rate;
        year.investmentBase = investmentBase;

        for (const b of Object.values(year.buckets)) b.tax = b.taxable * rate;

        const settle = (r: IncomeResult) => {
            const base = Math.max(0, r.gross);
            const czTax = base * rate;
            r.credit = Math.min(Math.max(0, r.withheld), czTax);
            r.tax = czTax - r.credit;
        };
        settle(year.dividends);
        settle(year.interest);

        year.totalTax =
            Object.values(year.buckets).reduce((s, b) => s + b.tax, 0) +
            year.dividends.tax +
            year.interest.tax;
    }

    return [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
}

/**
 * Kumulativní daňový závazek ke každému dni — z toho se pak dělá "po zdanění"
 * křivka portfolia (NAV mínus to, co z ní ještě odejde na daních).
 *
 * Daň se počítá po letech a mezi lety se nezapočítává, jen sčítá: zisk z loňska
 * ztrátou z letoška vynulovat nejde.
 */
export function taxLiabilityByDate(
    inputs: TaxInputs,
    settings: TaxSettings,
    dates: string[],
): Record<string, number> {
    const out: Record<string, number> = {};

    // Přepočítávat celý model pro každý den by bylo zbytečně drahé; stačí to
    // dělat ke dnům, kdy se něco realizovalo, a mezi nimi držet poslední hodnotu.
    const eventDates = new Set<string>([
        ...inputs.trades.map(t => t.date),
        ...(settings.liquidate ? inputs.unrealized.map(t => t.date) : []),
        ...inputs.dividends.map(d => d.date),
        ...inputs.dividendWithheld.map(d => d.date),
        ...inputs.interest.map(i => i.date),
        ...inputs.interestWithheld.map(i => i.date),
    ]);

    let last = 0;
    for (const d of dates) {
        if (eventDates.has(d)) {
            last = computeTax(inputs, settings, d).reduce((s, y) => s + y.totalTax, 0);
        }
        out[d] = last;
    }
    return out;
}

/** Souhrn přes všechny roky — pro karty a tabulku. */
export function summarizeTax(years: TaxYearResult[]) {
    const zero = { securities: 0, derivatives: 0, crypto: 0, other: 0 };
    const taxByBucket: Record<TaxBucketKey, number> = { ...zero };
    const taxableByBucket: Record<TaxBucketKey, number> = { ...zero };
    const exemptByBucket: Record<TaxBucketKey, number> = { ...zero };

    let dividendTax = 0, interestTax = 0, total = 0, unknown = 0;
    let dividendGross = 0, interestGross = 0, withheld = 0, interestPaid = 0;
    let grossIncome = 0, maxRate = 0;

    for (const y of years) {
        for (const key of Object.keys(y.buckets) as TaxBucketKey[]) {
            taxByBucket[key] += y.buckets[key].tax;
            taxableByBucket[key] += y.buckets[key].taxable;
            exemptByBucket[key] += y.buckets[key].exemptGain;
        }
        dividendTax += y.dividends.tax;
        interestTax += y.interest.tax;
        dividendGross += y.dividends.gross;
        interestGross += y.interest.gross;
        interestPaid += y.interest.nonDeductible;
        withheld += y.dividends.credit + y.interest.credit;
        unknown += y.unknownHoldingPnl;
        grossIncome += y.grossIncome;
        maxRate = Math.max(maxRate, y.rate);
        total += y.totalTax;
    }

    return {
        taxByBucket, taxableByBucket, exemptByBucket,
        dividendTax, interestTax, dividendGross, interestGross, withheld, interestPaid,
        grossIncome, rate: maxRate,
        unknownHoldingPnl: unknown,
        total,
    };
}

/**
 * Daň pasivního investora do indexu. Držené ETF se nezdaňuje vůbec — daň
 * vzniká až prodejem, a po třech letech ani tehdy. Zdaňují se jen vyplácené
 * dividendy (u distribučního ETF typu SPY), případně kapitálový zisk, kdyby
 * investor na konci období prodal.
 */
export function benchmarkTax(opts: {
    startValue: number;
    endValueBeforeCapitalTax: number;
    sold: boolean;
    holdingDays: number;
    settings: TaxSettings;
}): number {
    const { startValue, endValueBeforeCapitalTax, sold, holdingDays, settings } = opts;
    if (!sold) return 0;
    if (holdingDays >= settings.timeTestDays) return 0;
    const gain = Math.max(0, endValueBeforeCapitalTax - startValue);
    return gain * effectiveRate(gain, settings);
}

// ─── Paušální režim OSVČ ──────────────────────────────────────────────────────
//
// Tohle je u aktivního tradera často větší položka než daň ze zisků samotných.
// Podmínkou setrvání v paušálním režimu je, že úhrn příjmů z §8 (kapitálový
// majetek), §9 (nájem) a §10 (ostatní) nepřesáhne 50 000 Kč za rok. U prodeje
// cenných papírů se přitom počítá *hrubý příjem z prodeje*, ne zisk — limit se
// proto vyčerpá řádově dřív, než by člověk čekal.
//
// Když se limit překročí, paušální daň se za daný rok neuplatní: podává se
// běžné daňové přiznání a k tomu přehledy na OSSZ a zdravotní pojišťovnu.
// Zaplacené paušální zálohy se započtou (daňová část na daň, pojistné části
// na pojistné), takže se neztratí — ale rozdíl proti běžnému režimu doplatit
// musíš, a právě ten rozdíl je reálná cena tradingu navíc.

export const FLAT_TAX_INCOME_LIMIT = 50000;

// Sazby pojistného OSVČ. Vyměřovacím základem je polovina dílčího základu §7.
export const SOCIAL_RATE = 0.292;
export const HEALTH_RATE = 0.135;
export const INSURANCE_BASE_SHARE = 0.5;

// Základní sleva na poplatníka. Ověř si aktuální výši pro daný rok.
export const TAXPAYER_CREDIT = 30840;

export type ExpenseMode = 'lump' | 'actual';

export interface SelfEmployedSettings {
    income: number;           // roční příjmy z podnikání
    expenseMode: ExpenseMode;
    expenseRate: number;      // výdajový paušál (0.8 / 0.6 / 0.4 / 0.3)
    actualExpenses: number;   // skutečné výdaje, použijí se v režimu 'actual'
    flatTaxPaid: number;      // co bys za rok zaplatil na paušální dani
    taxpayerCredit: number;
}

export const DEFAULT_SELF_EMPLOYED: SelfEmployedSettings = {
    income: 0,
    expenseMode: 'lump',
    expenseRate: 0.6,
    actualExpenses: 0,
    flatTaxPaid: 0,
    taxpayerCredit: TAXPAYER_CREDIT,
};

export interface SelfEmployedResult {
    base7: number;            // dílčí základ §7
    expenses: number;
    social: number;
    health: number;
    incomeTax: number;        // daň z §7 i investic dohromady, po slevě
    totalDue: number;         // daň + odvody
    investmentTaxAlone: number; // kolik z daně připadá na investice (marginálně)
    regimeChangeCost: number; // co navíc proti paušální dani, bez daně z investic
    totalTradingCost: number; // celková cena tradingu = investiční daň + ztráta paušálu
}

/** Progresivní daň ze základu, počítáno od nuly. */
function progressiveTax(base: number, threshold: number): number {
    if (base <= 0) return 0;
    const lower = Math.min(base, threshold);
    return lower * LOWER_RATE + (base - lower) * UPPER_RATE;
}

export function computeSelfEmployed(
    se: SelfEmployedSettings,
    investmentBase: number,
    settings: TaxSettings,
): SelfEmployedResult {
    const expenses = se.expenseMode === 'actual'
        ? Math.min(se.actualExpenses, Math.max(0, se.income))
        : Math.min(
            Math.max(0, se.income) * se.expenseRate,
            EXPENSE_LUMP_CAPS[String(se.expenseRate)] ?? Infinity,
        );

    const base7 = Math.max(0, se.income - expenses);
    const threshold = settings.progressiveThreshold;

    // Investice se daní až "nad" podnikáním — pásmo pod hranicí zaplní §7 dřív.
    const taxOn7 = progressiveTax(base7, threshold);
    const taxOnAll = progressiveTax(base7 + Math.max(0, investmentBase), threshold);

    // Sleva se uplatní na daň jako celek, ne proti pojistnému, a nemůže jít pod nulu.
    const incomeTax = Math.max(0, taxOnAll - se.taxpayerCredit);

    // Skutečný mezní náklad investic je rozdíl daní *po slevě*. U nízkého základu
    // z podnikání totiž část slevy zůstává nevyužitá a pohltí daň z obchodování —
    // počítat rozdíl před slevou by cenu tradingu nadhodnotilo.
    const investmentTaxAlone = incomeTax - Math.max(0, taxOn7 - se.taxpayerCredit);

    const insuranceBase = base7 * INSURANCE_BASE_SHARE;
    const social = insuranceBase * SOCIAL_RATE;
    const health = insuranceBase * HEALTH_RATE;

    const totalDue = incomeTax + social + health;

    // Celá cena tradingu je rozdíl mezi tím, co reálně zaplatíš v běžném režimu,
    // a tím, co bys zaplatil na paušální dani, kdyby trading nebyl.
    const totalTradingCost = totalDue - se.flatTaxPaid;

    return {
        base7,
        expenses,
        social,
        health,
        incomeTax,
        totalDue,
        investmentTaxAlone,
        regimeChangeCost: totalTradingCost - investmentTaxAlone,
        totalTradingCost,
    };
}

// Měsíční záloha paušální daně. Výchozí hodnota odpovídá pásmu 1; ověř si ji
// pro daný rok, sazby se každoročně mění.
export const DEFAULT_FLAT_TAX_MONTHLY = 9162;
