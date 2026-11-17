import { computeAfterTaxComparison, type AfterTaxYearSettings } from './afterTaxComparison';
import { bucketOf, getTaxYearRules, selfEmployedTaxBase, TAXPAYER_CREDIT, TRADES_WITHOUT_EXECUTION_WARNING, type TaxInputs } from './tax';
import { assignFlowLandingDays, benchmarkInCurrency, computeTwr, type FlowPoint, type NavPoint } from './twr';
import type { CashBalance } from './cash';
import { FUND_DIVIDEND_WITHHOLDING, netTotalReturn } from './benchmarkData';
import { applyFxMethod, type FxMethod } from './taxFx';

export interface PersonalSeries {
    currency: string;
    fromDate: string;
    toDate: string;
    nav: NavPoint[];
    flows: FlowPoint[];
    fxToUsd: Record<string, number>;
    tax: TaxInputs;
    warnings?: string[];
    /** Cash per currency on the last day, values in base currency (FxPositions). */
    cashByCurrency?: CashBalance[];
    /** NAV without cash and accruals per day; tells whether positions were held at the start. */
    nonCashByDate?: Record<string, number>;
    /** Month-end rates of lot currencies for the uniform-rate method. */
    monthEndFx?: Record<string, Record<string, number>>;
}
export interface PersonalBenchmark {
    symbol: string;
    from: string;
    to: string;
    closes: Record<string, number>;
    prices: Record<string, number>;
    dividends: Record<string, number>;
    filledFromIntraday?: string[];
    /** Trading days whose close is missing even after the intraday fill. */
    missing?: string[];
}

export interface IndexPurchase { date: string; amount: number; priceUsd: number; fx: number; units: number }

/** Last observation on or before a date, together with the date it comes from. */
function observedOnOrBefore(values: Record<string, number>, date: string): { date: string; value: number } | null {
    let found: string | undefined;
    for (const day of Object.keys(values)) {
        if (day <= date && (!found || day > found) && Number.isFinite(values[day]) && values[day] > 0) found = day;
    }
    return found ? { date: found, value: values[found] } : null;
}

const days = (from: string, to: string) =>
    (Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8))
        - Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8))) / 86400000;

/**
 * Modified Dietz: gain over the capital that was actually invested, weighted by
 * how long each contribution stayed in. Unlike TWR it reflects the money at work.
 */
function moneyWeightedReturn(gain: number, initial: number, flows: [string, number][], from: string, to: string): number {
    const total = days(from, to);
    if (total <= 0) return NaN;
    const invested = initial + flows.reduce((sum, [date, amount]) => sum + amount * days(date, to) / total, 0);
    return invested > 0 ? gain / invested : NaN;
}

/** One decision for the user's confirmed profile, unaffected by old scenario preferences. */
export function computePersonalComparison(series: PersonalSeries, benchmark: PersonalBenchmark, businessIncome = 1_200_000) {
    if (series.currency !== 'CZK') throw new Error('Pro český daňový přehled potřebujeme Flex výpis v CZK.');
    if (series.nav.length < 2) throw new Error('Ve výpisu chybí dostatečná historie hodnoty účtu.');
    if (!Number.isFinite(businessIncome) || businessIncome < 0) throw new Error('Roční příjem OSVČ musí být nezáporná částka.');
    if (businessIncome > 1_500_000) throw new Error('Tento osobní přehled počítá s prvním pásmem paušální daně a příjmem do 1,5 mil. Kč. Vyšší příjem potřebuje jiné nastavení pásma.');
    if (benchmark.symbol !== 'SPY' || benchmark.from !== series.fromDate || benchmark.to !== series.toDate) {
        throw new Error('Ceny indexového ETF neodpovídají období tohoto výpisu.');
    }
    if (series.warnings?.some(w => w.startsWith('Chybí sekce Trades'))) throw new Error('Ve Flex výpisu chybí Trades. Zapni tuto sekci a obnov data.');
    if (series.warnings?.includes(TRADES_WITHOUT_EXECUTION_WARNING)) throw new Error('Sekce Trades ve Flex výpisu nemá úroveň Execution, takže by daň vyšla bez obchodů. Ve Flex query u Trades zapni „Execution“ a obnov data.');
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
    // SPY closes in New York when IBKR values the account; CSPX in London closes
    // 4.5 hours earlier. Net-of-withholding reinvestment gives CSPX's economics.
    const fund = netTotalReturn(benchmark.prices, benchmark.dividends, FUND_DIVIDEND_WITHHOLDING);
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
    // The law offers daily rates or the uniform annual rate for the whole
    // return. Like the dividend regime, use the one that costs the trader less.
    const methods = (['daily', 'uniform'] as FxMethod[]).map(method => {
        const conversion = applyFxMethod(series.tax, method, series.monthEndFx, lastDate, series.currency);
        return { method, conversion, result: computeAfterTaxComparison({
            nav: series.nav, flows: series.flows, fxToUsd: series.fxToUsd, tax: conversion.tax,
            prices: fund, dividends: {}, from: startDate, to: lastDate,
            distributing: false, liquidationMode: 'ibkr', annualSettings,
            foreignCredit: 'dividends15', foreignIncomeMode: 'auto',
        }) };
    });
    const [chosen, alternative] = methods[1].result.trading.totalCost < methods[0].result.trading.totalCost - 0.5
        ? [methods[1], methods[0]] : [methods[0], methods[1]];
    const { result } = chosen;
    const lotsInPeriod = [...series.tax.trades.filter(item => item.date > startDate && item.date <= lastDate),
        ...series.tax.unrealized.filter(item => item.date === lastDate)];
    const foreign = lotsInPeriod.filter(item => item.lot && item.lot.currency !== series.currency);
    const openPriced = series.tax.unrealized.filter(item => item.date === lastDate && Math.round(item.pnl) !== 0);
    const fx = {
        method: chosen.method,
        investmentTax: Object.fromEntries(methods.map(m => [m.method, m.result.trading.investmentTax])) as Record<FxMethod, number>,
        totalCost: Object.fromEntries(methods.map(m => [m.method, m.result.trading.totalCost])) as Record<FxMethod, number>,
        alternative: alternative.method,
        uniformRates: methods[1].conversion.uniformRates.filter(row => row.year === year || foreign.some(item => item.lot!.openDate.startsWith(String(row.year)))),
        /** Lots with a purchase price; without any, both methods equal broker P/L. */
        lots: lotsInPeriod.filter(item => item.lot).length,
        missingPurchaseFx: foreign.filter(item => item.lot!.openFx === undefined).length,
        /** Open positions without lots are converted at today's rate including their cost. */
        openPositionsWithoutLots: openPriced.filter(item => !item.lot).length,
    };
    const periodFlows = Object.entries(landed).filter(([date]) => date > startDate && date <= lastDate)
        .sort(([a], [b]) => a.localeCompare(b));
    const netContributions = periodFlows.reduce((sum, [, amount]) => sum + amount, 0);
    const bench = benchmarkInCurrency(fund, dates, series.fxToUsd);
    const twr = computeTwr(series.nav.filter(point => point.date >= startDate), landed);
    const benchStart = bench[startDate];
    const twrRows = twr.map(point => ({ date: point.date, portfolio: (point.index - 1) * 100,
        benchmark: benchStart && bench[point.date] ? (bench[point.date] / benchStart - 1) * 100 : null }));

    // ── Index: what exactly the passive variant bought and at which prices ──
    const startPrice = observedOnOrBefore(fund, startDate);
    const endPrice = observedOnOrBefore(fund, lastDate);
    const startFx = series.fxToUsd[startDate];
    const endFx = series.fxToUsd[lastDate];
    if (!startPrice || !endPrice || !(startFx > 0) || !(endFx > 0)) throw new Error('Chybí cena indexového ETF nebo kurz USD/CZK pro začátek či konec období.');
    const purchases: IndexPurchase[] = periodFlows.map(([date, amount]) => {
        const priceUsd = observedOnOrBefore(fund, date)!.value;
        const fx = observedOnOrBefore(series.fxToUsd, date)!.value;
        return { date, amount, priceUsd, fx, units: amount / (priceUsd * fx) };
    });
    const startUnits = opening.nav / (startPrice.value * startFx);
    // Weekends and US holidays reuse the last close. A session Yahoo lost, or a
    // gap longer than any regular closure, would buy or value at an old price.
    const missingCloses = new Set(benchmark.missing ?? []);
    const staleDates = [...new Set([startDate, ...periodFlows.map(([date]) => date), lastDate])].flatMap(date => {
        const observed = observedOnOrBefore(fund, date);
        return observed && observed.date < date && (missingCloses.has(date) || days(observed.date, date) > 4)
            ? [{ date, priceDate: observed.date }] : [];
    });
    const periodDividends = Object.entries(benchmark.dividends).filter(([date, amount]) => date > startDate && date <= lastDate && amount > 0);
    const index = {
        startPrice: startPrice.value, startPriceDate: startPrice.date, startFx,
        endPrice: endPrice.value, endPriceDate: endPrice.date, endFx,
        startUnits, units: startUnits + purchases.reduce((sum, p) => sum + p.units, 0), purchases,
        returnUsd: endPrice.value / startPrice.value - 1,
        fxChange: endFx / startFx - 1,
        returnCzk: (endPrice.value * endFx) / (startPrice.value * startFx) - 1,
        staleDates,
        dividendCount: periodDividends.length,
        dividendsUsd: periodDividends.reduce((total, [, amount]) => total + amount, 0),
        withholding: FUND_DIVIDEND_WITHHOLDING,
        filledFromIntraday: (benchmark.filledFromIntraday ?? []).filter(date => date >= startDate && date <= lastDate),
    };

    // ── Trading: where the account's gross gain comes from ──
    const inPeriod = (date: string) => date > startDate && date <= lastDate;
    const sum = <T,>(items: T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);
    const byBucket = (items: { assetCategory: string; pnl: number }[]) => {
        const out = { securities: 0, derivatives: 0, other: 0 };
        for (const item of items) {
            const bucket = bucketOf(item.assetCategory);
            out[bucket === 'securities' || bucket === 'derivatives' ? bucket : 'other'] += item.pnl;
        }
        return out;
    };
    const tradingGross = result.trading.gross - opening.nav - netContributions;
    // Purchases at their own day's rate: the gain in koruny as the NAV measures it.
    const economic = methods[0].conversion.tax;
    const realized = byBucket(economic.trades.filter(item => inPeriod(item.date)));
    const unrealized = byBucket(economic.unrealized.filter(item => item.date === lastDate));
    const dividends = sum(series.tax.dividends.filter(item => inPeriod(item.date)), item => item.amount);
    const withheld = sum([...series.tax.dividendWithheld, ...series.tax.interestWithheld].filter(item => inPeriod(item.date)), item => item.amount);
    const interestItems = series.tax.interest.filter(item => inPeriod(item.date));
    const isExpense = (item: { kind?: string; amount: number }) => item.kind === 'expense' || (!item.kind && item.amount < 0);
    const interestReceived = sum(interestItems.filter(item => !isExpense(item)), item => item.amount);
    const interestPaid = sum(interestItems.filter(isExpense), item => item.amount);
    const explained = realized.securities + realized.derivatives + realized.other
        + unrealized.securities + unrealized.derivatives + unrealized.other
        + dividends + withheld + interestReceived + interestPaid;
    const tradingSources = {
        realized, unrealized, dividends, withheld, interestReceived, interestPaid,
        // FX translation of cash, fees and P/L of positions opened before the period.
        other: tradingGross - explained,
    };

    // Broker P/L of positions already held at the start counts from their purchase,
    // so it includes earlier years; the opening NAV contains that part already.
    const openingNonCash = series.nonCashByDate?.[startDate];
    const carriedPositions = openingNonCash === undefined
        ? (opening.nav > Math.max(1_000, 0.01 * result.trading.gross) ? null : 0)
        : (Math.abs(openingNonCash) > Math.max(1_000, 0.01 * opening.nav) ? openingNonCash : 0);

    const passiveGross = result.passive.gross - opening.nav - netContributions;
    const yearRow = result.annual.find(row => row.year === String(year));
    return {
        startDate, lastDate, year, partialYear: startDate > yearEnd,
        initialValue: opening.nav, netContributions, annualSettings, result,
        tradingGain: result.trading.net - opening.nav - netContributions,
        passiveGain: result.passive.net - opening.nav - netContributions,
        grossGain: { trading: tradingGross, passive: passiveGross },
        returns: {
            twr: { trading: twrRows.at(-1)!.portfolio / 100, passive: (twrRows.at(-1)!.benchmark ?? NaN) / 100 },
            moneyWeighted: {
                trading: moneyWeightedReturn(tradingGross, opening.nav, periodFlows, startDate, lastDate),
                passive: moneyWeightedReturn(passiveGross, opening.nav, periodFlows, startDate, lastDate),
            },
        },
        index, tradingSources, fx,
        /** Value of positions held at the start; 0 = none, null = unknown but the opening NAV is material. */
        carriedPositions,
        cash: series.cashByCurrency?.map(row => ({ ...row, share: row.value / result.trading.gross })) ?? null,
        taxDetail: yearRow ? { trading: yearRow.trading.detail, passive: yearRow.passive.detail } : null,
        gapRows: result.points.map(point => ({ date: point.date, gross: point.tradingGross - point.passiveGross })),
        twrRows,
    };
}
