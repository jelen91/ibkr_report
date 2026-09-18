import test from 'node:test';
import assert from 'node:assert/strict';
import { computePersonalComparison, type PersonalSeries, type PersonalBenchmark } from '../app/lib/personalComparison';
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
    const benchmark: PersonalBenchmark = { symbol: 'CSPX.L', from: series.fromDate, to: series.toDate, closes: prices, prices, dividends: {} };
    return { series, benchmark };
}

test('personal overview always uses YTD, closes IBKR and holds CSPX under the confirmed 60% OSVC profile', () => {
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
    assert.throws(() => computePersonalComparison(series, { ...benchmark, symbol: 'SPY' }), /neodpovídají/);
    assert.throws(() => computePersonalComparison(series, { ...benchmark, to: '20260915' }), /neodpovídají/);
    assert.throws(() => computePersonalComparison(series, benchmark, NaN), /Roční příjem/);
    assert.throws(() => computePersonalComparison(series, benchmark, 1_500_001), /pásma/);
    assert.throws(() => computePersonalComparison({ ...series, warnings: ['Chybí sekce Trades; odhad daně nezahrnuje realizované obchody.'] }, benchmark), /Trades/);
    assert.throws(() => computePersonalComparison({ ...series, warnings: ['Chybí sekce Open Positions; nelze modelovat daň při likvidaci.'] }, benchmark), /Open Positions/);
    assert.throws(() => computePersonalComparison({ ...series, fxToUsd: { '20260916': 1 } }, benchmark), /kurz/);
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
