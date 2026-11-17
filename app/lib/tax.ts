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
//   • Dividendy a úroky jsou §8; smluvní zápočet zahraniční daně vyžaduje
//     samostatné ověření. Samotná částka FRTAX neprokazuje nárok na zápočet.

export type TaxBucketKey = 'securities' | 'derivatives' | 'crypto' | 'other';

/** Flex Trades exist only at other levels (Order, Closed Lot…); the tax inputs would silently be empty. */
export const TRADES_WITHOUT_EXECUTION_WARNING = 'Sekce Trades neobsahuje jednotlivé obchody (úroveň Execution); odhad daně je bez realizovaných obchodů.';

export interface RealizedTrade {
    date: string;            // YYYYMMDD, den obchodu
    assetCategory: string;   // STK / OPT / FUT / CASH / CRYPTO …
    pnl: number;             // realizovaný zisk/ztráta v bázové měně
    proceeds: number;        // hrubý příjem z prodeje v bázové měně (0 u nákupů)
    holdingDays: number | null; // null = dobu držení se nepodařilo dohledat
    acquiredDate?: string;   // skutečné datum nabytí celého prodávaného lotu
    exemptionEligible?: boolean; // false např. u krátkého prodeje
}

export interface CashItem {
    date: string;
    amount: number;
    kind?: 'income' | 'expense'; // rozliší storno připsaného úroku od úroku debetního
    creditableAmount?: number; // ověřený zápočet dle smlouvy a země, nikoli pouhá srážka
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
    // Zahrne nerealizované výsledky daného portfolia při jeho koncovém prodeji.
    // Srovnávací model určuje samostatně, které portfolio se prodává a které drží.
    liquidate: boolean;
    taxYear?: number;
}

export const LOWER_RATE = 0.15;
export const UPPER_RATE = 0.23;

// Ověřeno 2026-09-17. ČSSZ: minimum hlavní činnosti pro rok 2026 bylo
// novelou účinnou 1.7.2026 zpětně sníženo na 35 % průměrné mzdy.
// https://www.cssz.gov.cz/-/informace-pro-osvc-o-zmene-pojistneho-na-duchodove-pojisteni-od-1-7-2026
// https://www.vzp.cz/platci/informace/osvc/osvc-minimalni-vyse-zaloh
// https://financnisprava.gov.cz/cs/dane/dane/dan-z-prijmu/zamestnanci-zamestnavatele/obecne-informace
const TAX_YEAR_RULES: Record<number, {
    progressiveThreshold: number;
    socialMinimumBase: number;
    socialMaximumBase: number;
    healthMinimumBase: number;
    flatTaxMonthly: number;
}> = {
    2024: { progressiveThreshold: 1_582_812, socialMinimumBase: 158_292, socialMaximumBase: 2_110_416, healthMinimumBase: 263_802, flatTaxMonthly: 7_498 },
    2025: { progressiveThreshold: 1_676_052, socialMinimumBase: 195_540, socialMaximumBase: 2_234_736, healthMinimumBase: 279_342, flatTaxMonthly: 8_716 },
    2026: { progressiveThreshold: 1_762_812, socialMinimumBase: 205_668, socialMaximumBase: 2_350_416, healthMinimumBase: 293_802, flatTaxMonthly: 9_162 },
};

export const getTaxYearRules = (year: number) => TAX_YEAR_RULES[year] ?? null;

export function taxSettingsForYear(settings: TaxSettings, year: number): TaxSettings {
    return { ...settings, taxYear: year,
        progressiveThreshold: settings.progressiveThreshold > 0 && (settings.taxYear === undefined || settings.taxYear === year)
            ? settings.progressiveThreshold : (getTaxYearRules(year)?.progressiveThreshold ?? NaN) };
}

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
    if (!Number.isFinite(income) || !Number.isFinite(expenseRate) || expenseRate < 0 || expenseRate > 1) return NaN;
    if (income <= 0) return 0;
    const cap = EXPENSE_LUMP_CAPS[String(expenseRate)] ?? income * expenseRate;
    return Math.max(0, income - Math.min(income * expenseRate, cap));
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
    rateMode: 'fixed15',
    timeTestDays: 1095,
    valueTestLimit: 100000,
    otherTaxBase: 0,
    progressiveThreshold: 0, // 0 = zákonná hranice pro konkrétní kalendářní rok
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

    const resolved = taxSettingsForYear(settings, settings.taxYear ?? 2026);
    const room = Math.max(0, resolved.progressiveThreshold - Math.max(0, settings.otherTaxBase));
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
    warnings: string[];         // limity dat, kvůli kterým nejde o daňové přiznání
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

export const bucketOf = (assetCategory: string): TaxBucketKey =>
    BUCKET_OF[assetCategory?.toUpperCase()] ?? 'other';

const emptyBucket = (): BucketResult => ({
    gain: 0, exemptGain: 0, proceeds: 0, taxable: 0, tax: 0, valueTestApplied: false,
});

function taxDate(value: string): Date {
    const compact = value.replace(/-/g, '').slice(0, 8);
    if (!/^\d{8}$/.test(compact)) throw new Error(`Neplatné datum daňového podkladu: ${value}`);
    const d = new Date(Date.UTC(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8)));
    if (d.toISOString().slice(0, 10).replace(/-/g, '') !== compact) throw new Error(`Neplatné datum daňového podkladu: ${value}`);
    return d;
}

const dateKey = (date: string) => taxDate(date).toISOString().slice(0, 10).replace(/-/g, '');
const finiteAmount = (amount: number) => {
    if (!Number.isFinite(amount)) throw new Error('Daňový podklad obsahuje chybějící nebo neplatnou částku.');
    return amount;
};

/** Tři kalendářní roky, nikoli 1095 dní. Zákon požaduje dobu delší než tři roky. */
export function passesTimeTest(trade: Pick<RealizedTrade, 'date' | 'holdingDays' | 'acquiredDate' | 'exemptionEligible'>,
    settings: TaxSettings = DEFAULT_TAX_SETTINGS): boolean {
    if (trade.exemptionEligible === false) return false;
    const sold = taxDate(trade.date);
    let acquired: Date;
    if (trade.acquiredDate) acquired = taxDate(trade.acquiredDate);
    else if (trade.holdingDays !== null && Number.isFinite(trade.holdingDays) && trade.holdingDays >= 0) {
        acquired = new Date(sold.getTime() - trade.holdingDays * 86400000);
    } else return false;
    if (settings.timeTestDays !== 1095) {
        return (sold.getTime() - acquired.getTime()) / 86400000 > settings.timeTestDays;
    }
    // 29. únor má v nepřestupném roce výročí 28. února.
    const anniversaryYear = acquired.getUTCFullYear() + 3;
    const lastDay = new Date(Date.UTC(anniversaryYear, acquired.getUTCMonth() + 1, 0)).getUTCDate();
    const anniversary = Date.UTC(anniversaryYear, acquired.getUTCMonth(), Math.min(acquired.getUTCDate(), lastDay));
    return sold.getTime() > anniversary;
}

const hasTests = (key: TaxBucketKey, date: string) =>
    key === 'securities' || (key === 'crypto' && date >= '20250215');

// Hodnotový a časový test: https://financnisprava.gov.cz/cs/dane/dane/dan-z-prijmu/fyzicke-osoby/ostatni
// Krypto od 15.2.2025: https://financnisprava.gov.cz/assets/cs/prilohy/d-placeni-dani/Krypto-29_4_2026.pdf
// Zrušení limitu 40 mil. pro CP od 2026:
// https://financnisprava.gov.cz/cs/financni-sprava/media-a-verejnost/tiskove-zpravy-gfr/tiskove-zpravy-2026/danove-novinky-pro-rok-2026

/**
 * Orientační model v CZK z brokerova P/L. Neprovádí české přepočty nákupních
 * a prodejních cen ani rekonstrukci opčních přiřazení. Chybějící zahraniční
 * smluvní limit zápočtu se nesmí nahradit automatickým zápočtem celé srážky.
 */
export function computeTax(inputs: TaxInputs, settings: TaxSettings, upToDate?: string): TaxYearResult[] {
    const cutoff = upToDate ? dateKey(upToDate) : undefined;
    const within = (date: string) => !cutoff || dateKey(date) <= cutoff;
    const years = new Map<string, TaxYearResult>();
    const positionsByYear = new Map<string, RealizedTrade[]>();
    const approvedCredit = new Map<string, { dividends: number; interest: number }>();
    const income = (): IncomeResult => ({ gross: 0, nonDeductible: 0, withheld: 0, credit: 0, tax: 0 });
    const yearFor = (date: string): TaxYearResult => {
        const y = dateKey(date).slice(0, 4);
        let r = years.get(y);
        if (!r) {
            r = { year: y,
                buckets: { securities: emptyBucket(), derivatives: emptyBucket(), crypto: emptyBucket(), other: emptyBucket() },
                dividends: income(), interest: income(), totalTax: 0, unknownHoldingPnl: 0,
                rate: LOWER_RATE, investmentBase: 0, grossIncome: 0, warnings: [],
            };
            years.set(y, r);
        }
        return r;
    };
    const positions = settings.liquidate ? [...inputs.trades, ...inputs.unrealized] : inputs.trades;
    for (const t of positions) {
        if (!within(t.date)) continue;
        finiteAmount(t.pnl);
        finiteAmount(t.proceeds);
        const y = yearFor(t.date);
        const trades = positionsByYear.get(y.year) ?? [];
        trades.push({ ...t, date: dateKey(t.date), proceeds: Math.max(0, t.proceeds) });
        positionsByYear.set(y.year, trades);
    }

    // Storna dividend se započtou proti příjmu, nejsou dalším nedaňovým výdajem.
    for (const d of inputs.dividends) if (within(d.date)) yearFor(d.date).dividends.gross += finiteAmount(d.amount);
    for (const i of inputs.interest) if (within(i.date)) {
        const r = yearFor(i.date).interest;
        if (i.kind === 'expense' || (!i.kind && i.amount < 0)) r.nonDeductible -= finiteAmount(i.amount);
        else r.gross += finiteAmount(i.amount);
    }
    for (const [items, kind] of [[inputs.dividendWithheld, 'dividends'], [inputs.interestWithheld, 'interest']] as const) {
        for (const w of items) if (within(w.date)) {
            const y = yearFor(w.date);
            y[kind].withheld -= finiteAmount(w.amount);
            const approved = approvedCredit.get(y.year) ?? { dividends: 0, interest: 0 };
            approved[kind] += Math.max(0, finiteAmount(w.creditableAmount ?? 0));
            approvedCredit.set(y.year, approved);
        }
    }

    for (const year of years.values()) {
        const trades = positionsByYear.get(year.year) ?? [];
        if (trades.length) year.warnings.push('Model používá brokerovo P/L, nikoli české pořizovací a prodejní ceny s daňovými kurzy. Nezná investice mimo tento report.');
        if (trades.some(t => bucketOf(t.assetCategory) === 'derivatives')) {
            year.warnings.push('U derivátů je nutné ověřit časové zařazení prémií, přiřazení a uplatnění opcí; brokerův okamžik realizace se může lišit od daňového.');
        }
        const testedProceeds = { securities: 0, crypto: 0, derivatives: 0, other: 0 };
        for (const t of trades) {
            const key = bucketOf(t.assetCategory);
            year.buckets[key].proceeds += t.proceeds;
            // Hodnotový test zahrnuje i prodeje splňující časový test.
            // U krypta v roce 2025 se započítávají příjmy až od 15.2.2025.
            if (hasTests(key, t.date)) testedProceeds[key] += t.proceeds;
        }
        const exemptByValue = (t: RealizedTrade) => {
            const key = bucketOf(t.assetCategory);
            return hasTests(key, t.date) && t.exemptionEligible !== false &&
                testedProceeds[key] > 0 && testedProceeds[key] <= settings.valueTestLimit;
        };
        const exemptByTime = (t: RealizedTrade) =>
            hasTests(bucketOf(t.assetCategory), t.date) && passesTimeTest(t, settings);
        const capped = (t: RealizedTrade) => year.year === '2025' || bucketOf(t.assetCategory) === 'crypto';
        const cappedProceeds = trades.reduce((sum, t) =>
            sum + (!exemptByValue(t) && exemptByTime(t) && capped(t) ? t.proceeds : 0), 0);
        const exemptShare = cappedProceeds > 40_000_000 ? 40_000_000 / cappedProceeds : 1;
        if (exemptShare < 1) year.warnings.push('Překročen limit osvobození 40 mil. Kč; model nezná jiné prodeje a ocenění CP k 31.12.2024.');

        for (const t of trades) {
            const key = bucketOf(t.assetCategory);
            const b = year.buckets[key];
            let share = 0;
            if (exemptByValue(t)) {
                share = 1;
                b.valueTestApplied = true;
            } else if (exemptByTime(t)) share = capped(t) ? exemptShare : 1;
            b.exemptGain += t.pnl * share;
            b.gain += t.pnl * (1 - share);
            year.grossIncome += t.proceeds * (1 - share);
            if (share < 1 && hasTests(key, t.date) && t.exemptionEligible !== false &&
                t.holdingDays === null && !t.acquiredDate && t.pnl > 0) year.unknownHoldingPnl += t.pnl;
        }
        if (year.unknownHoldingPnl > 0) year.warnings.push('U části prodaných lotů není ověřeno datum nabytí; model u nich neuplatnil časový test.');
        for (const b of Object.values(year.buckets)) b.taxable = Math.max(0, b.gain);
        year.dividends.gross = Math.max(0, year.dividends.gross);
        year.interest.gross = Math.max(0, year.interest.gross);
        year.interest.nonDeductible = Math.max(0, year.interest.nonDeductible);
        year.grossIncome += year.dividends.gross + year.interest.gross;
        year.investmentBase = Object.values(year.buckets).reduce((s, b) => s + b.taxable, 0) +
            year.dividends.gross + year.interest.gross;
        const yearSettings = taxSettingsForYear(settings, Number(year.year));
        year.rate = effectiveRate(year.investmentBase, yearSettings);
        if (!getTaxYearRules(Number(year.year))) year.warnings.push('Pro tento rok nejsou ověřené parametry daně a pojistného.');
        for (const b of Object.values(year.buckets)) b.tax = b.taxable * year.rate;
        for (const kind of ['dividends', 'interest'] as const) {
            const r = year[kind];
            r.withheld = Math.max(0, r.withheld);
            const czTax = r.gross * year.rate;
            r.credit = Math.min(approvedCredit.get(year.year)?.[kind] ?? 0, r.withheld, czTax);
            r.tax = czTax - r.credit;
            if (r.withheld > r.credit) year.warnings.push(`Zahraniční srážka (${kind === 'dividends' ? 'dividendy' : 'úroky'}) nemá ověřený smluvní zápočet; částka modelu je bez neověřeného zápočtu.`);
        }
        year.totalTax = Object.values(year.buckets).reduce((s, b) => s + b.tax, 0) + year.dividends.tax + year.interest.tax;
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
    const eventDates = [...new Set<string>([
        ...inputs.trades.map(t => t.date),
        ...(settings.liquidate ? inputs.unrealized.map(t => t.date) : []),
        ...inputs.dividends.map(d => d.date),
        ...inputs.dividendWithheld.map(d => d.date),
        ...inputs.interest.map(i => i.date),
        ...inputs.interestWithheld.map(i => i.date),
    ].map(dateKey))].sort();

    let last = 0;
    let nextEvent = 0;
    for (const d of [...new Set(dates)].sort((a, b) => dateKey(a).localeCompare(dateKey(b)))) {
        let changed = false;
        while (nextEvent < eventDates.length && eventDates[nextEvent] <= dateKey(d)) {
            nextEvent++;
            changed = true;
        }
        if (changed) {
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
    const warnings = new Set<string>();

    for (const y of years) {
        for (const warning of y.warnings ?? []) warnings.add(`${y.year}: ${warning}`);
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
        warnings: [...warnings],
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
    disposalDate?: string;
    acquiredDate?: string;
}): number {
    const { startValue, endValueBeforeCapitalTax, sold, holdingDays, settings } = opts;
    if (!sold) return 0;
    if (endValueBeforeCapitalTax <= settings.valueTestLimit) return 0;
    const timeExempt = opts.disposalDate
        ? passesTimeTest({ date: opts.disposalDate, holdingDays, acquiredDate: opts.acquiredDate }, settings)
        : holdingDays > 1096; // bez data nelze rozlišit přestupný rok
    const gain = Math.max(0, endValueBeforeCapitalTax - startValue);
    const year = opts.disposalDate ? Number(dateKey(opts.disposalDate).slice(0, 4)) : (settings.taxYear ?? 2026);
    const taxable = timeExempt
        ? (year === 2025 ? gain * Math.max(0, 1 - 40_000_000 / endValueBeforeCapitalTax) : 0)
        : gain;
    return taxable * effectiveRate(taxable, taxSettingsForYear(settings, year));
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

// Sociální pojistné od 2024: 55 % základu §7; zdravotní nadále 50 %.
export const SOCIAL_RATE = 0.292;
export const HEALTH_RATE = 0.135;
export const SOCIAL_BASE_SHARE = 0.55;
export const HEALTH_BASE_SHARE = 0.5;

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
    year?: number;
    monthsActive?: number;    // model hlavní činnosti, standardně celý rok
    foreignTaxCredit?: number; // pouze ověřený zahraniční zápočet
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
    year: number;
    assumptions: string[];
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
    const year = se.year ?? settings.taxYear ?? 2026;
    const rules = getTaxYearRules(year);
    const months = Math.max(0, Math.min(12, Math.floor(se.monthsActive ?? 12)));
    const expenses = se.expenseMode === 'actual'
        ? Math.min(Math.max(0, se.actualExpenses), Math.max(0, se.income))
        : Math.min(
            Math.max(0, se.income) * se.expenseRate,
            EXPENSE_LUMP_CAPS[String(se.expenseRate)] ?? Infinity,
        );

    const base7 = Math.max(0, se.income - expenses);
    const threshold = taxSettingsForYear(settings, year).progressiveThreshold;

    // Investice se daní až "nad" podnikáním — pásmo pod hranicí zaplní §7 dřív.
    const taxOn7 = Math.ceil(progressiveTax(Math.floor(base7 / 100) * 100, threshold));
    const taxOnAll = Math.ceil(progressiveTax(Math.floor((base7 + Math.max(0, investmentBase)) / 100) * 100, threshold));

    // Sleva se uplatní na daň jako celek, ne proti pojistnému, a nemůže jít pod nulu.
    const credit = Math.max(0, se.taxpayerCredit);
    const incomeTax = Math.max(0, taxOnAll - credit - Math.max(0, se.foreignTaxCredit ?? 0));

    // Skutečný mezní náklad investic je rozdíl daní *po slevě*. U nízkého základu
    // z podnikání totiž část slevy zůstává nevyužitá a pohltí daň z obchodování —
    // počítat rozdíl před slevou by cenu tradingu nadhodnotilo.
    const investmentTaxAlone = Math.max(0, incomeTax - Math.max(0, taxOn7 - credit));

    const socialBase = rules ? Math.min(rules.socialMaximumBase,
        Math.max(base7 * SOCIAL_BASE_SHARE, rules.socialMinimumBase * months / 12)) : NaN;
    const healthBase = rules ? Math.max(base7 * HEALTH_BASE_SHARE, rules.healthMinimumBase * months / 12) : NaN;
    const social = Math.ceil(Math.ceil(socialBase) * SOCIAL_RATE - 1e-9);
    const health = Math.ceil(healthBase * HEALTH_RATE - 1e-9);

    const totalDue = incomeTax + social + health;

    // Celá cena tradingu je rozdíl mezi tím, co reálně zaplatíš v běžném režimu,
    // a tím, co bys zaplatil na paušální dani, kdyby trading nebyl.
    const totalTradingCost = totalDue - se.flatTaxPaid;

    return {
        year,
        assumptions: ['Hlavní činnost bez výjimek z minim, bez zaměstnání a dalších slev.',
            ...(rules ? [] : ['Pro tento rok nejsou ověřené parametry pojistného.'])],
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
