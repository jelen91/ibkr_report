import {
    computeSelfEmployed, computeTax, DEFAULT_SELF_EMPLOYED, DEFAULT_TAX_SETTINGS,
    FLAT_TAX_INCOME_LIMIT, getTaxYearRules, TAXPAYER_CREDIT,
    type CashItem, type ExpenseMode, type TaxInputs,
} from './tax';
import {
    assignFlowLandingDays, isValidYmd, simulatePassiveLedger,
    type FlowPoint, type NavPoint,
} from './twr';

export interface AfterTaxYearSettings {
    otherTaxBase: number;
    businessIncome: number;
    expenseMode: ExpenseMode;
    expenseRate: number;
    actualExpenses: number;
    flatTaxRegime: boolean;
    flatTaxMonthly: number;
    taxpayerCredit: number;
}

export const DEFAULT_AFTER_TAX_YEAR_SETTINGS: AfterTaxYearSettings = {
    otherTaxBase: 0, businessIncome: 0, expenseMode: 'lump', expenseRate: 0.6,
    actualExpenses: 0, flatTaxRegime: false, flatTaxMonthly: 9162,
    taxpayerCredit: TAXPAYER_CREDIT,
};

export interface AnnualStrategyCost {
    investmentTax: number;
    regimeCost: number;
    totalCost: number;
    withheld: number;
    foreignCredit: number;
    investmentBase: number;
    grossIncome: number;
    flatTaxBroken: boolean;
    /** The chosen treatment of eligible foreign dividends, before any shared-prefix subtraction. */
    dividendTaxMode: 'progressive' | 'separate15' | null;
    /** Whole-year components behind the costs, for display; not reduced by the shared prefix. */
    detail: AnnualCostDetail;
}

export interface AnnualCostDetail {
    /** Taxable gain per basket after exemptions; a negative basket is not taxed or offset. */
    securitiesGain: number;
    derivativesGain: number;
    otherGain: number;
    dividends: number;
    interest: number;
    /** Gross sale proceeds and income compared with the 50 000 CZK flat-tax limit. */
    flatTaxIncome: number;
    /** Normal-regime costs that replace the flat tax once it is lost. */
    social: number;
    health: number;
    businessIncomeTax: number;
    flatTaxPaid: number;
}

export interface AfterTaxComparisonResult {
    /** Realized-tax reserves only. Terminal liquidation is never backdated. */
    points: { date: string; tradingGross: number; passiveGross: number; tradingNet: number; passiveNet: number }[];
    trading: { gross: number; investmentTax: number; regimeCost: number; totalCost: number; net: number; withheld: number };
    passive: { gross: number; investmentTax: number; regimeCost: number; totalCost: number; net: number; withheld: number };
    delta: number;
    /** Cumulative annual amounts; subtract prefix to obtain the interval cost. */
    annual: { year: string; trading: AnnualStrategyCost; passive: AnnualStrategyCost; prefix: AnnualStrategyCost }[];
    warnings: string[];
}

export type LiquidationMode = 'none' | 'ibkr' | 'both';

export interface AfterTaxComparisonOptions {
    nav: NavPoint[];
    /** External contributions/withdrawals in CZK; assigned to ending NAV days. */
    flows: FlowPoint[];
    fxToUsd: Record<string, number>;
    prices: Record<string, number>;
    dividends: Record<string, number>;
    from: string;
    to: string;
    tax: TaxInputs;
    distributing: boolean;
    /** Terminal sales affect the verdict only; the chart always uses realized transactions. */
    liquidationMode: LiquidationMode;
    annualSettings: Record<string, AfterTaxYearSettings>;
    defaultYearSettings?: AfterTaxYearSettings;
    foreignCredit: 'none' | 'dividends15' | 'capped15';
    /** Separate 15% base applies to foreign dividends, not unverified CINT interest. */
    foreignIncomeMode?: 'progressive' | 'separate15' | 'auto';
}

const INPUT_KEYS = ['trades', 'unrealized', 'dividends', 'dividendWithheld', 'interest', 'interestWithheld'] as const;
const emptyInputs = (): TaxInputs => ({ trades: [], unrealized: [], dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] });
const emptyDetail = (): AnnualCostDetail => ({ securitiesGain: 0, derivativesGain: 0, otherGain: 0, dividends: 0,
    interest: 0, flatTaxIncome: 0, social: 0, health: 0, businessIncomeTax: 0, flatTaxPaid: 0 });
const emptyCost = (): AnnualStrategyCost => ({ investmentTax: 0, regimeCost: 0, totalCost: 0, withheld: 0,
    foreignCredit: 0, investmentBase: 0, grossIncome: 0, flatTaxBroken: false, dividendTaxMode: null, detail: emptyDetail() });

function filterInputs(inputs: TaxInputs, predicate: (date: string) => boolean): TaxInputs {
    return {
        trades: inputs.trades.filter(item => predicate(item.date)), unrealized: [],
        dividends: inputs.dividends.filter(item => predicate(item.date)),
        dividendWithheld: inputs.dividendWithheld.filter(item => predicate(item.date)),
        interest: inputs.interest.filter(item => predicate(item.date)),
        interestWithheld: inputs.interestWithheld.filter(item => predicate(item.date)),
    };
}

function combineInputs(left: TaxInputs, right: TaxInputs): TaxInputs {
    return {
        trades: [...left.trades, ...right.trades], unrealized: [],
        dividends: [...left.dividends, ...right.dividends],
        dividendWithheld: [...left.dividendWithheld, ...right.dividendWithheld],
        interest: [...left.interest, ...right.interest],
        interestWithheld: [...left.interestWithheld, ...right.interestWithheld],
    };
}

function personalTax(base: number, threshold: number): number {
    const positive = Math.max(0, base);
    return Math.min(positive, threshold) * 0.15 + Math.max(0, positive - threshold) * 0.23;
}

/**
 * Scenario, not a tax return. Both strategies inherit the same known annual
 * transactions through the opening NAV. Only the change in their annual Czech
 * tax/regime cost is charged to the selected period. Withholding is already in
 * actual NAV and in the passive dividend ledger, so it is never deducted again.
 * Taxes are reserves payable outside the account, without simulated financing
 * costs or a second sale to fund tax. The ETF is purchased at the opening NAV.
 */
export function computeAfterTaxComparison(opts: AfterTaxComparisonOptions): AfterTaxComparisonResult {
    if (!isValidYmd(opts.from) || !isValidYmd(opts.to) || opts.from >= opts.to) {
        throw new Error('Srovnání vyžaduje dvě různá platná data.');
    }
    const landed = assignFlowLandingDays(opts.nav, opts.flows);
    const nav = opts.nav.filter(point => point.date >= opts.from && point.date <= opts.to);
    if (nav[0]?.date !== opts.from || nav.at(-1)?.date !== opts.to || nav[0].nav <= 0) {
        throw new Error('Chybí počáteční nebo konečné NAV pro daňové srovnání.');
    }
    for (const key of INPUT_KEYS) for (const item of opts.tax[key]) {
        if (!isValidYmd(item.date)) throw new Error('Daňové vstupy musí mít platná data YYYYMMDD.');
    }
    if (!['none', 'ibkr', 'both'].includes(opts.liquidationMode)) {
        throw new Error('Neplatný scénář koncového prodeje.');
    }
    if (opts.liquidationMode !== 'none' && opts.tax.unrealized.some(item => item.date !== opts.to)) {
        throw new Error('Pro prodej portfolia IBKR chybí společné aktuální ocenění otevřených pozic k poslednímu NAV. Vypni koncový prodej nebo načti výpisy ke stejnému dni.');
    }
    for (const point of nav) {
        if (!Number.isFinite(opts.fxToUsd[point.date]) || opts.fxToUsd[point.date] <= 0) {
            throw new Error(`Chybí kurz USD/CZK k ${point.date}.`);
        }
    }
    const warnings = new Set<string>([
        'Jde o model v CZK. Obě strategie začínají stejným hrubým NAV a mají stejné vklady i výběry. ETF se nakupuje na začátku zvoleného období.',
        'Známé příjmy před začátkem období jsou společným daňovým základem obou variant. Odečítá se pouze změna ročního daňového závazku; záporná změna znamená uvolnění rezervy.',
        'Sražené daně jsou již v hodnotě účtu i ETF. Dodatečná česká daň se drží jako rezerva bez modelování dne úhrady, financování a poplatků hypotetických obchodů.',
    ]);
    if (opts.foreignCredit === 'capped15') warnings.add('Scénář předpokládá doložitelný zahraniční zápočet dividend i úroků nejvýše 15 % příslušných příjmů a nejvýše skutečné srážky i české daně. Země a smluvní nárok nejsou z tohoto reportu ověřeny; tento předpoklad není vhodný pro irskou srážku z úroků se smluvní sazbou 0 %.');
    else if (opts.foreignCredit === 'dividends15') warnings.add('Scénář předpokládá doložitelný zahraniční zápočet dividend nejvýše 15 % příjmů, skutečné srážky a české daně. Úrokové srážky nezapočítává; u irských úroků má smlouva s ČR sazbu 0 % a případná refundace se řeší odděleně.');
    else warnings.add('Scénář neuplatňuje zápočet zahraničních srážek; dodatečná česká daň je proto konzervativní odhad.');
    const foreignIncomeMode = opts.foreignIncomeMode ?? 'separate15';
    if (!['progressive', 'separate15', 'auto'].includes(foreignIncomeMode)) {
        throw new Error('Neplatný způsob zdanění zahraničních dividend.');
    }
    if (foreignIncomeMode === 'separate15') warnings.add('Scénář řadí dividendy do samostatného základu zahraničních příjmů se sazbou 15 % bez slevy na poplatníka. Úroky zůstávají v progresivním základu, protože jejich způsobilost není doložena.');
    if (foreignIncomeMode === 'auto') warnings.add('Pro každý rok a každou strategii se automaticky volí nižší česká daň ze dvou přípustných způsobů zdanění zahraničních dividend: společný základ se sazbami 15 / 23 % a slevou na poplatníka, nebo samostatný základ se sazbou 15 % bez této slevy. Při shodě se použije samostatný základ. Úroky zůstávají ve společném základu a nárok na zahraniční zápočet se touto volbou nezvyšuje.');
    if (opts.distributing) warnings.add('SPY modeluje 15% americkou srážku a reinvestici čisté dividendy v den dividendové události. Skutečný den výplaty/reinvestice a poplatky se mohou lišit.');
    warnings.add('Bez ověřeného data nabytí se neuplatňuje časové osvobození. Brokerovo P/L a realizace opcí jsou odhad daňových vstupů; výpis nemusí pokrývat celý rok ani jiné investice.');

    const fromYear = Number(opts.from.slice(0, 4));
    const toYear = Number(opts.to.slice(0, 4));
    const yearKeys = Array.from({ length: toYear - fromYear + 1 }, (_, index) => String(fromYear + index));
    const settingsByYear = new Map<string, AfterTaxYearSettings>();
    for (const year of yearKeys) {
        const rules = getTaxYearRules(Number(year));
        if (!rules) throw new Error(`Pro rok ${year} chybí ověřené parametry daně.`);
        const settings = opts.annualSettings[year] ?? opts.defaultYearSettings ?? {
            ...DEFAULT_AFTER_TAX_YEAR_SETTINGS, flatTaxMonthly: rules.flatTaxMonthly,
        };
        for (const key of ['otherTaxBase', 'businessIncome', 'expenseRate', 'actualExpenses', 'flatTaxMonthly', 'taxpayerCredit'] as const) {
            if (!Number.isFinite(settings[key]) || settings[key] < 0) throw new Error(`Neplatný daňový parametr ${key} pro rok ${year}.`);
        }
        if (settings.expenseRate > 1) throw new Error(`Neplatný výdajový paušál pro rok ${year}.`);
        if (!opts.annualSettings[year]) warnings.add(`${year}: používají se výchozí roční daňové předpoklady; zkontroluj příjmy, slevu a režim pro každý rok.`);
        if (settings.flatTaxRegime && settings.businessIncome === 0) warnings.add(`${year}: obrat OSVČ je nastaven na 0 Kč. Dopad ztráty paušálního režimu počítá s nulovým obratem a hlavní činností celý rok; pro osobní výsledek zadej svůj roční obrat.`);
        settingsByYear.set(year, settings);
    }

    const annualCost = (allInputs: TaxInputs, year: string): AnnualStrategyCost => {
        const original = filterInputs(allInputs, date => date.startsWith(year));
        const settings = settingsByYear.get(year)!;
        const rules = getTaxYearRules(Number(year))!;
        const inputs = { ...original };
        // Aggregate corrections and withholding refunds before capping a credit.
        const normalizeWithholding = (items: CashItem[], income: number, allowCredit: boolean): CashItem[] => {
            const withheld = Math.max(0, -items.reduce((sum, item) => sum + item.amount, 0));
            return withheld ? [{ date: `${year}1231`, amount: -withheld,
                creditableAmount: allowCredit ? Math.min(withheld, Math.max(0, income) * 0.15) : 0 }] : [];
        };
        const dividendGross = Math.max(0, inputs.dividends.reduce((sum, item) => sum + item.amount, 0));
        const interestGross = Math.max(0, inputs.interest.filter(item => item.kind !== 'expense' && (item.kind === 'income' || item.amount > 0))
            .reduce((sum, item) => sum + item.amount, 0));
        inputs.dividendWithheld = normalizeWithholding(inputs.dividendWithheld, dividendGross, opts.foreignCredit !== 'none');
        inputs.interestWithheld = normalizeWithholding(inputs.interestWithheld, interestGross, opts.foreignCredit === 'capped15');
        const taxSettings = { ...DEFAULT_TAX_SETTINGS, rateMode: 'auto' as const,
            otherTaxBase: settings.otherTaxBase, taxYear: Number(year) };
        const combined = computeTax(inputs, taxSettings)[0];
        if (!combined) return emptyCost();
        for (const warning of combined.warnings) warnings.add(`${year}: ${warning}`);
        const otherIncomeTax = personalTax(settings.otherTaxBase, rules.progressiveThreshold);
        const unusedCredit = Math.max(0, settings.taxpayerCredit - otherIncomeTax);
        const flatTaxBroken = combined.grossIncome > FLAT_TAX_INCOME_LIMIT;
        const candidate = (mode: 'progressive' | 'separate15') => {
            const separateDividends = mode === 'separate15';
            const progressive = separateDividends
                ? computeTax({ ...inputs, dividends: [], dividendWithheld: [] }, taxSettings)[0]
                : combined;
            const approvedProgressiveCredit = (progressive?.dividends.credit ?? 0) + (progressive?.interest.credit ?? 0);
            const progressiveBeforeForeignCredit = Math.max(0, (progressive?.totalTax ?? 0) + approvedProgressiveCredit - unusedCredit);
            const usedProgressiveCredit = Math.min(approvedProgressiveCredit, progressiveBeforeForeignCredit);
            const dividendCredit = separateDividends
                ? Math.min(dividendGross * 0.15, inputs.dividendWithheld[0]?.creditableAmount ?? 0) : 0;
            const investmentTax = progressiveBeforeForeignCredit - usedProgressiveCredit
                + (separateDividends ? dividendGross * 0.15 - dividendCredit : 0);
            return { dividendTaxMode: mode,
                investmentTax: settings.flatTaxRegime && !flatTaxBroken ? 0 : investmentTax,
                foreignCredit: settings.flatTaxRegime && !flatTaxBroken ? 0 : dividendCredit + usedProgressiveCredit };
        };
        const selected = foreignIncomeMode === 'auto'
            ? (() => {
                const progressive = candidate('progressive');
                const separate = candidate('separate15');
                return progressive.investmentTax < separate.investmentTax ? progressive : separate;
            })()
            : candidate(foreignIncomeMode);
        const investmentTax = selected.investmentTax;
        let regimeCost = 0;
        const detail: AnnualCostDetail = {
            ...emptyDetail(),
            securitiesGain: combined.buckets.securities.gain,
            derivativesGain: combined.buckets.derivatives.gain,
            otherGain: combined.buckets.crypto.gain + combined.buckets.other.gain,
            dividends: combined.dividends.gross, interest: combined.interest.gross,
            flatTaxIncome: combined.grossIncome,
        };
        if (settings.flatTaxRegime) {
            if (flatTaxBroken) {
                const selfEmployed = computeSelfEmployed({
                    ...DEFAULT_SELF_EMPLOYED, income: settings.businessIncome,
                    expenseMode: settings.expenseMode, expenseRate: settings.expenseRate,
                    actualExpenses: settings.actualExpenses, taxpayerCredit: settings.taxpayerCredit,
                    flatTaxPaid: settings.flatTaxMonthly * 12, year: Number(year),
                }, 0, taxSettings);
                detail.social = selfEmployed.social;
                detail.health = selfEmployed.health;
                detail.businessIncomeTax = Math.max(0, otherIncomeTax - settings.taxpayerCredit);
                detail.flatTaxPaid = settings.flatTaxMonthly * 12;
                regimeCost = detail.social + detail.health + detail.businessIncomeTax - detail.flatTaxPaid;
            }
        }
        return {
            investmentTax, regimeCost, totalCost: investmentTax + regimeCost,
            withheld: combined.dividends.withheld + combined.interest.withheld,
            foreignCredit: selected.foreignCredit, dividendTaxMode: selected.dividendTaxMode,
            investmentBase: combined.investmentBase, grossIncome: combined.grossIncome, flatTaxBroken, detail,
        };
    };

    const prefix = filterInputs(opts.tax, date => date <= opts.from);
    const prefixCosts = new Map(yearKeys.map(year => [year, annualCost(prefix, year)]));
    const landedFlows = Object.entries(landed).map(([date, amount]) => ({ date, amount }));
    const passiveInputs = (date: string, liquidate: boolean) => {
        const ledger = simulatePassiveLedger({
            flows: landedFlows, prices: opts.prices, dividends: opts.distributing ? opts.dividends : {},
            fxToBase: opts.fxToUsd, from: opts.from, to: date, startValue: nav[0].nav,
            dividendRate: opts.distributing ? 0.15 : 0, liquidate,
        });
        if (!ledger) throw new Error('Chybí ceny ETF nebo pasivní varianta nedokáže pokrýt stejné výběry bez úvěru.');
        const hypothetical = emptyInputs();
        hypothetical.trades = ledger.trades;
        for (const [year, amount] of Object.entries(ledger.dividendIncomeByYear)) {
            const eventDate = year === date.slice(0, 4) ? date : `${year}1231`;
            hypothetical.dividends.push({ date: eventDate, amount });
            hypothetical.dividendWithheld.push({ date: eventDate, amount: -amount * 0.15 });
        }
        return { value: ledger.value, tax: combineInputs(prefix, hypothetical) };
    };
    const costsThrough = (inputs: TaxInputs, date: string) => {
        const annual = yearKeys.filter(year => year <= date.slice(0, 4)).map(year => ({
            year, cost: annualCost(inputs, year), prefix: prefixCosts.get(year)!,
        }));
        const cost = annual.reduce((sum, row) => ({
            investmentTax: sum.investmentTax + row.cost.investmentTax - row.prefix.investmentTax,
            regimeCost: sum.regimeCost + row.cost.regimeCost - row.prefix.regimeCost,
            totalCost: sum.totalCost + row.cost.totalCost - row.prefix.totalCost,
            withheld: sum.withheld + row.cost.withheld - row.prefix.withheld,
        }), { investmentTax: 0, regimeCost: 0, totalCost: 0, withheld: 0 });
        return { annual, cost };
    };
    const evaluate = (point: NavPoint, liquidateTrading: boolean, liquidatePassive: boolean) => {
        const actual = filterInputs(opts.tax, date => date <= point.date);
        if (liquidateTrading) {
            actual.trades.push(...opts.tax.unrealized.filter(item => item.date === opts.to));
        }
        const alternative = passiveInputs(point.date, liquidatePassive);
        const tradingCosts = costsThrough(actual, point.date);
        const passiveCosts = costsThrough(alternative.tax, point.date);
        return {
            trading: { gross: point.nav, ...tradingCosts.cost, net: point.nav - tradingCosts.cost.totalCost },
            passive: { gross: alternative.value, ...passiveCosts.cost, net: alternative.value - passiveCosts.cost.totalCost },
            annual: tradingCosts.annual.map((row, index) => ({ year: row.year, trading: row.cost,
                passive: passiveCosts.annual[index].cost, prefix: row.prefix })),
        };
    };
    let last: ReturnType<typeof evaluate> | undefined;
    const points = nav.map(point => {
        const result = evaluate(point, false, false);
        last = result;
        return { date: point.date, tradingGross: result.trading.gross, passiveGross: result.passive.gross,
            tradingNet: result.trading.net, passiveNet: result.passive.net };
    });
    const final = opts.liquidationMode !== 'none'
        ? evaluate(nav.at(-1)!, true, opts.liquidationMode === 'both') : last!;
    if (opts.liquidationMode === 'none') warnings.add('Koncový verdikt ponechává otevřené pozice IBKR i indexové ETF držené. Započítává pouze daňové dopady dosavadních realizací, výběrů a příjmů.');
    if (opts.liquidationMode === 'ibkr') warnings.add('Koncový verdikt modeluje prodej pouze portfolia IBKR; indexové ETF zůstává držené. U ETF se započítají daně z případných výběrů a dividend, nikoli daň z koncového prodeje. Nejde o potvrzení časového osvobození ani projekci hodnoty ETF po třech letech.');
    if (opts.liquidationMode === 'both') warnings.add('Koncový verdikt modeluje prodej portfolia IBKR i indexového ETF k poslednímu dni zvoleného období.');
    if (opts.liquidationMode !== 'none') warnings.add('Graf zachycuje průběžně vzniklé daně bez koncového prodeje; skutečné nabývací ceny/loty portfolia IBKR mohou předcházet začátku období.');
    return { ...final, points, delta: final.trading.net - final.passive.net, warnings: [...warnings] };
}
