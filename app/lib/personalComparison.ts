import { computeAfterTaxComparison, type AfterTaxYearSettings } from './afterTaxComparison';
import { getTaxYearRules, selfEmployedTaxBase, TAXPAYER_CREDIT, type TaxInputs } from './tax';
import { assignFlowLandingDays, benchmarkInCurrency, computeTwr, type FlowPoint, type NavPoint } from './twr';

export interface PersonalSeries {
    currency: string;
    fromDate: string;
    toDate: string;
    nav: NavPoint[];
    flows: FlowPoint[];
    fxToUsd: Record<string, number>;
    tax: TaxInputs;
    warnings?: string[];
}
export interface PersonalBenchmark {
    symbol: string;
    from: string;
    to: string;
    closes: Record<string, number>;
    prices: Record<string, number>;
    dividends: Record<string, number>;
}

/** One decision for the user's confirmed profile, unaffected by old scenario preferences. */
export function computePersonalComparison(series: PersonalSeries, benchmark: PersonalBenchmark, businessIncome = 1_200_000) {
    if (series.currency !== 'CZK') throw new Error('Pro český daňový přehled potřebujeme Flex výpis v CZK.');
    if (series.nav.length < 2) throw new Error('Ve výpisu chybí dostatečná historie hodnoty účtu.');
    if (!Number.isFinite(businessIncome) || businessIncome < 0) throw new Error('Roční příjem OSVČ musí být nezáporná částka.');
    if (businessIncome > 1_500_000) throw new Error('Tento osobní přehled počítá s prvním pásmem paušální daně a příjmem do 1,5 mil. Kč. Vyšší příjem potřebuje jiné nastavení pásma.');
    if (benchmark.symbol !== 'CSPX.L' || benchmark.from !== series.fromDate || benchmark.to !== series.toDate) {
        throw new Error('Ceny indexového ETF neodpovídají období tohoto výpisu.');
    }
    if (series.warnings?.some(w => w.startsWith('Chybí sekce Trades'))) throw new Error('Ve Flex výpisu chybí Trades. Zapni tuto sekci a obnov data.');
    if (series.warnings?.some(w => w.startsWith('Chybí sekce Open Positions'))) throw new Error('Ve Flex výpisu chybí Open Positions pro ocenění uzavření obchodů. Zapni tuto sekci a obnov data.');
    const lastDate = series.nav.at(-1)!.date;
    const year = Number(lastDate.slice(0, 4));
    const yearEnd = `${year - 1}1231`;
    const baseline = series.nav.filter(point => point.date <= yearEnd).at(-1);
    // Permit the last business-day observation around New Year, never a stale
    // observation from months earlier masquerading as the year's opening NAV.
    const recentBaseline = baseline && baseline.date >= `${year - 1}1224` && baseline.nav > 0;
    const opening = recentBaseline ? baseline : series.nav.find(point => point.date > yearEnd && point.nav > 0);
    if (!opening || opening.nav <= 0 || opening.date >= lastDate) throw new Error('Chybí počáteční hodnota účtu pro letošní srovnání.');
    const startDate = opening.date;
    const landed = assignFlowLandingDays(series.nav, series.flows);
    const dates = series.nav.filter(point => point.date >= startDate).map(point => point.date);
    const annualSettings = Object.fromEntries([...new Set(dates.map(date => date.slice(0, 4)))].map(y => {
        const rules = getTaxYearRules(Number(y));
        if (!rules) throw new Error(`Pro rok ${y} nejsou dostupná ověřená daňová pravidla.`);
        return [y, {
            otherTaxBase: selfEmployedTaxBase(businessIncome, 0.6), businessIncome,
            expenseMode: 'lump', expenseRate: 0.6, actualExpenses: 0,
            flatTaxRegime: true, flatTaxMonthly: rules.flatTaxMonthly, taxpayerCredit: TAXPAYER_CREDIT,
        } satisfies AfterTaxYearSettings];
    }));
    const result = computeAfterTaxComparison({
        nav: series.nav, flows: series.flows, fxToUsd: series.fxToUsd, tax: series.tax,
        prices: benchmark.prices, dividends: benchmark.dividends, from: startDate, to: lastDate,
        distributing: false, liquidationMode: 'ibkr', annualSettings,
        foreignCredit: 'dividends15', foreignIncomeMode: 'auto',
    });
    const netContributions = Object.entries(landed).filter(([date]) => date > startDate && date <= lastDate)
        .reduce((sum, [, amount]) => sum + amount, 0);
    const bench = benchmarkInCurrency(benchmark.closes, dates, series.fxToUsd);
    const twr = computeTwr(series.nav.filter(point => point.date >= startDate), landed);
    const benchStart = bench[startDate];
    return {
        startDate, lastDate, year, partialYear: startDate > yearEnd,
        initialValue: opening.nav, netContributions, annualSettings, result,
        tradingGain: result.trading.net - opening.nav - netContributions,
        passiveGain: result.passive.net - opening.nav - netContributions,
        twrRows: twr.map(point => ({ date: point.date, portfolio: (point.index - 1) * 100,
            benchmark: benchStart && bench[point.date] ? (bench[point.date] / benchStart - 1) * 100 : null })),
    };
}
