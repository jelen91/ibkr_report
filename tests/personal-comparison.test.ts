import test from 'node:test';
import assert from 'node:assert/strict';
import { computePersonalComparison, type PersonalSeries, type PersonalBenchmark } from '../app/lib/personalComparison';
import { TRADES_WITHOUT_EXECUTION_WARNING } from '../app/lib/tax';
const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-7, `${value} != ${expected}`);
function fixture() {
    const series: PersonalSeries = {
        currency: 'CZK', fromDate: '20250917', toDate: '20260916',
        nav: [{ date: '20250917', nav: 100 }, { date: '20251231', nav: 1_000_000 }, { date: '20260916', nav: 1_100_000 }],
        flows: [{ date: '20251231', amount: 999_900 }],
        fxToUsd: { '20250917': 1, '20251231': 1, '20260916': 1 },
        tax: { trades: [], unrealized: [{ date: '20260916', assetCategory: 'OPT', pnl: 100_000, proceeds: 100_000, holdingDays: null }], dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] },
    };
    const prices = { '20250917': 50, '20251231': 100, '20260916': 110 };
    const benchmark: PersonalBenchmark = { symbol: 'SPY', from: series.fromDate, to: series.toDate, closes: prices, prices, dividends: {} };
    return { series, benchmark };
}

test('personal overview always uses YTD, closes IBKR and holds the index under the confirmed 60% OSVC profile', () => {
    const { series, benchmark } = fixture();
    const original = structuredClone({ series, benchmark });
    const view = computePersonalComparison(series, benchmark);
    assert.equal(view.startDate, '20251231');
    assert.equal(view.year, 2026);
    assert.equal(view.partialYear, false);
    near(view.initialValue, 1_000_000);
    near(view.netContributions, 0);
    near(view.result.trading.investmentTax, 15_000);
    near(view.result.trading.regimeCost, 47_968);
    near(view.result.trading.net, 1_037_032);
    near(view.result.passive.investmentTax, 0);
    near(view.result.passive.net, 1_100_000);
    near(view.tradingGain, 37_032);
    near(view.passiveGain, 100_000);
    near(view.result.delta, -62_968);
    near(view.annualSettings['2026'].otherTaxBase, 480_000);
    assert.equal(view.annualSettings['2025'].flatTaxMonthly, 8_716);
    assert.equal(view.annualSettings['2026'].flatTaxMonthly, 9_162);
    near(view.twrRows.at(-1)!.portfolio, 10);
    near(view.twrRows.at(-1)!.benchmark!, 10);
    assert.deepEqual({ series, benchmark }, original);
});

test('cashflows affect both strategies once and are excluded from the displayed profits', () => {
    const { series, benchmark } = fixture();
    series.nav.splice(2, 0, { date: '20260302', nav: 1_200_000 });
    series.nav.at(-1)!.nav = 1_320_000;
    series.fxToUsd['20260302'] = 1;
    benchmark.prices['20260302'] = 100;
    series.flows.push({ date: '20260301', amount: 200_000 });
    series.tax.unrealized[0].pnl = 120_000;
    series.tax.unrealized[0].proceeds = 120_000;
    const view = computePersonalComparison(series, benchmark);
    near(view.netContributions, 200_000);
    near(view.result.passive.net, 1_320_000);
    near(view.passiveGain, 120_000);
    near(view.tradingGain, 54_032);
    near(view.result.delta, -65_968);
});

test('an account without a year-opening balance clearly reports a partial year', () => {
    const { series, benchmark } = fixture();
    series.nav = [{ date: '20260202', nav: 1_000_000 }, { date: '20260916', nav: 1_100_000 }];
    series.fromDate = benchmark.from = '20260202';
    series.fxToUsd['20260202'] = 1;
    benchmark.prices['20260202'] = 100;
    const view = computePersonalComparison(series, benchmark);
    assert.equal(view.partialYear, true);
    assert.equal(view.startDate, '20260202');
});

test('the fixed overview refuses wrong currencies, benchmarks and incomplete tax sources', () => {
    const { series, benchmark } = fixture();
    assert.throws(() => computePersonalComparison({ ...series, currency: 'USD' }, benchmark), /CZK/);
    assert.throws(() => computePersonalComparison(series, { ...benchmark, symbol: 'CSPX.L' }), /neodpovídají/);
    assert.throws(() => computePersonalComparison(series, { ...benchmark, to: '20260915' }), /neodpovídají/);
    assert.throws(() => computePersonalComparison(series, benchmark, NaN), /Roční příjem/);
    assert.throws(() => computePersonalComparison(series, benchmark, 1_500_001), /pásma/);
    assert.throws(() => computePersonalComparison({ ...series, warnings: ['Chybí sekce Trades; odhad daně nezahrnuje realizované obchody.'] }, benchmark), /Trades/);
    assert.throws(() => computePersonalComparison({ ...series, warnings: ['Chybí sekce Open Positions; nelze modelovat daň při likvidaci.'] }, benchmark), /Open Positions/);
    assert.throws(() => computePersonalComparison({ ...series, fxToUsd: { '20260916': 1 } }, benchmark), /kurz/);
    assert.throws(() => computePersonalComparison({ ...series, warnings: [TRADES_WITHOUT_EXECUTION_WARNING] }, benchmark), /Execution/);
});

test('a stale prior-year NAV cannot turn a partial year into a full YTD result', () => {
    const { series, benchmark } = fixture();
    series.nav = [{ date: '20250630', nav: 900_000 }, { date: '20260202', nav: 1_000_000 }, { date: '20260916', nav: 1_100_000 }];
    series.fromDate = benchmark.from = '20250630';
    series.fxToUsd['20260202'] = 1;
    benchmark.prices['20260202'] = 100;
    const view = computePersonalComparison(series, benchmark);
    assert.equal(view.partialYear, true);
    assert.equal(view.startDate, '20260202');
    near(view.initialValue, 1_000_000);
});

test('the breakdown reconciles gross gains, taxes and the flat-tax regime with the verdict', () => {
    const { series, benchmark } = fixture();
    series.cashByCurrency = [{ currency: 'USD', quantity: 40_000, value: 880_000 }];
    const view = computePersonalComparison(series, benchmark);
    near(view.grossGain.trading, 100_000);
    near(view.grossGain.passive, 100_000);
    const src = view.tradingSources;
    near(src.unrealized.derivatives, 100_000);
    near(src.other, 0);
    const explained = src.realized.securities + src.realized.derivatives + src.realized.other + src.unrealized.securities
        + src.unrealized.derivatives + src.unrealized.other + src.dividends + src.withheld + src.interestReceived + src.interestPaid + src.other;
    near(explained, view.grossGain.trading);
    const detail = view.taxDetail!.trading;
    near(detail.derivativesGain, 100_000);
    near(detail.flatTaxIncome, 100_000);
    near(detail.social + detail.health + detail.businessIncomeTax - detail.flatTaxPaid, view.result.trading.regimeCost);
    near(view.grossGain.trading - view.grossGain.passive - view.result.trading.totalCost + view.result.passive.totalCost, view.result.delta);
    assert.deepEqual(view.index.staleDates, []);
    near(view.index.units, 10_000);
    near(view.index.returnUsd, 0.1);
    near(view.index.returnCzk, 0.1);
    near(view.returns.moneyWeighted.trading, 0.1);
    near(view.returns.twr.passive, 0.1);
    near(view.cash![0].share, 0.8);
    near(view.gapRows.at(-1)!.gross, 0);
});

test('index purchases follow the landed cashflows and money-weighted return uses their timing', () => {
    const { series, benchmark } = fixture();
    series.nav.splice(2, 0, { date: '20260302', nav: 1_200_000 });
    series.nav.at(-1)!.nav = 1_320_000;
    series.fxToUsd['20260302'] = 1;
    benchmark.prices['20260302'] = 100;
    series.flows.push({ date: '20260301', amount: 200_000 });
    const view = computePersonalComparison(series, benchmark);
    assert.deepEqual(view.index.purchases, [{ date: '20260302', amount: 200_000, priceUsd: 100, fx: 1, units: 2_000 }]);
    near(view.index.units, 12_000);
    near(view.returns.moneyWeighted.trading, 120_000 / (1_000_000 + 200_000 * 198 / 259));
});

test('a missing ETF close on the last NAV day is flagged instead of passing silently', () => {
    const { series, benchmark } = fixture();
    benchmark.prices = { '20250917': 50, '20251231': 100 };
    benchmark.closes = { ...benchmark.prices };
    const view = computePersonalComparison(series, benchmark);
    assert.deepEqual(view.index.staleDates, [{ date: '20260916', priceDate: '20251231' }]);
    assert.equal(view.index.endPriceDate, '20251231');
});

test('a deposit day whose session Yahoo lost is flagged, while a market holiday is not', () => {
    const { series, benchmark } = fixture();
    series.nav.splice(2, 0, { date: '20260302', nav: 1_200_000 });
    series.nav.at(-1)!.nav = 1_320_000;
    series.fxToUsd['20260302'] = 1;
    benchmark.prices['20260227'] = 100;
    series.flows.push({ date: '20260301', amount: 200_000 });
    const holiday = computePersonalComparison(series, benchmark);
    assert.deepEqual(holiday.index.staleDates, []);
    const lost = computePersonalComparison(series, { ...benchmark, missing: ['20260302'] });
    assert.deepEqual(lost.index.staleDates, [{ date: '20260302', priceDate: '20260227' }]);
});

test('SPY dividends are reinvested after 15% withholding like an accumulating fund, without Czech dividend tax', () => {
    const { series, benchmark } = fixture();
    benchmark.dividends = { '20260916': 2 };
    const view = computePersonalComparison(series, benchmark);
    near(view.index.returnUsd, 0.117);
    near(view.index.endPrice, 110);
    near(view.result.passive.gross, 1_117_000);
    near(view.result.passive.investmentTax, 0);
    near(view.returns.twr.passive, 0.117);
    assert.equal(view.index.dividendCount, 1);
    near(view.index.dividendsUsd, 2);
});

test('positions held at the start are reported, because broker P/L counts them from purchase', () => {
    const { series, benchmark } = fixture();
    assert.equal(computePersonalComparison(series, benchmark).carriedPositions, null);
    const nonCash = { '20250917': 0, '20251231': 300_000, '20260916': 400_000 };
    assert.equal(computePersonalComparison({ ...series, nonCashByDate: nonCash }, benchmark).carriedPositions, 300_000);
    assert.equal(computePersonalComparison({ ...series, nonCashByDate: { ...nonCash, '20251231': 500 } }, benchmark).carriedPositions, 0);
    const smallStart = structuredClone(series);
    smallStart.nav[1].nav = 3_000;
    smallStart.flows = [];
    assert.equal(computePersonalComparison(smallStart, benchmark).carriedPositions, 0);
});
