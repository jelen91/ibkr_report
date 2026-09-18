import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assignFlowLandingDays, benchmarkInCurrency, computeTwr, detectInception,
    isValidYmd, mergeNavSeries, simulatePassive, simulatePassiveLedger,
} from '../app/lib/twr';
import { extractSeries } from '../app/lib/flexPerformance';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const nav = (values: number[], dates = ['20260102', '20260105', '20260106']) => values.map((value, i) => ({ date: dates[i], nav: value }));
const statement = (overrides: Record<string, unknown> = {}) => ({
    accountId: 'TEST', fromDate: '20260102', toDate: '20260106', AccountInformation: { currency: 'CZK' },
    EquitySummaryInBase: { EquitySummaryByReportDateInBase: nav([100, 110, 121]).map(n => ({ reportDate: n.date, total: String(n.nav), currency: 'CZK' })) },
    StmtFunds: {}, Transfers: {}, Trades: {}, OpenPositions: {},
    ConversionRates: { ConversionRate: [{ fromCurrency: 'USD', toCurrency: 'CZK', reportDate: '20260102', rate: '25' }] },
    ...overrides,
});

test('TWR removes a deposit and a withdrawal without altering market return', () => {
    const values = nav([100, 160, 156]);
    const flows = assignFlowLandingDays(values, [{ date: '20260105', amount: 50 }, { date: '20260106', amount: -20 }]);
    close(computeTwr(values, flows).at(-1)!.index, 1.21);
});

test('a weekend flow belongs to the next NAV interval and is not discarded', () => {
    assert.deepEqual(assignFlowLandingDays(nav([100, 150, 150]), [{ date: '20260103', amount: 50 }]), { '20260105': 50 });
});

test('flow dates do not move to hide a genuine loss or gain', () => {
    assert.deepEqual(assignFlowLandingDays(nav([100, 100, 200]), [{ date: '20260105', amount: 100 }]), { '20260105': 100 });
});

test('inception and returns retain small-account history regardless of future deposits', () => {
    const values = nav([100, 50, 10050]);
    assert.equal(detectInception(values).inception, '20260102');
    close(computeTwr(values, { '20260106': 10000 }).at(-1)!.index, 0.5);
});

test('USD TWR converts beginning NAV, ending NAV and flow at their respective rates', () => {
    close(computeTwr(nav([2500, 4400]), { '20260105': 2200 }, { fxToUsd: { '20260102': 25, '20260105': 22 } }).at(-1)!.index, 1);
    assert.throws(() => computeTwr(nav([100, 110]), {}, { fxToUsd: { '20260102': 25 } }), /kurz/);
});

test('invalid NAV dates, duplicate observations and nonfinite amounts fail explicitly', () => {
    assert.equal(isValidYmd('20260230'), false);
    assert.throws(() => computeTwr(nav([100, NaN]), {}));
    assert.throws(() => computeTwr(nav([100, 110], ['20260102', '20260102']), {}));
});

test('benchmark carries USD price before converting holiday FX and uses pre-range prices', () => {
    assert.deepEqual(benchmarkInCurrency({ '20260102': 100 }, ['20260103', '20260104'], { '20260103': 25, '20260104': 24 }), { '20260103': 2500, '20260104': 2400 });
    assert.deepEqual(benchmarkInCurrency({ '20260105': 100 }, ['20260102']), {});
});

test('passive simulation does not double-count the baseline flow or borrow future prices', () => {
    close(simulatePassive([{ date: '20260102', amount: 100 }, { date: '20260105', amount: 100 }], { '20260102': 10, '20260105': 10, '20260106': 11 }, ['20260102', '20260105', '20260106'], '20260102', 100), 220);
    assert.ok(Number.isNaN(simulatePassive([], { '20260105': 10 }, ['20260102', '20260105'], '20260102', 100)));
    assert.ok(Number.isNaN(simulatePassive([{ date: '20260105', amount: -200 }], { '20260102': 10 }, ['20260102', '20260105'], '20260102', 100)));
});

test('multiaccount totals use common NAV dates without inventing pre-opening capital', () => {
    const one = { accountIds: ['A'], currency: 'CZK', nav: nav([100, 110, 121]), flows: [], fxToUsd: {} };
    const two = { ...one, accountIds: ['B'], nav: nav([200, 210], ['20260105', '20260106']) };
    assert.deepEqual(mergeNavSeries([one, two]).nav, [{ date: '20260105', nav: 310 }, { date: '20260106', nav: 331 }]);
    assert.throws(() => mergeNavSeries([one, one]), /Stejný/);
    assert.throws(() => mergeNavSeries([one, { ...two, currency: 'USD' }]), /měny/);
});

test('parser trusts deposit reportDate rather than request or settlement date', () => {
    const parsed = extractSeries([statement({ StmtFunds: { StatementOfFundsLine: { date: '20260103', reportDate: '20260105', settleDate: '20260103', amount: '50', activityCode: 'DEP', levelOfDetail: 'BaseCurrency' } } })]);
    assert.deepEqual(parsed.flows, [{ date: '20260105', amount: 50 }]);
});

test('overlapping statements do not double NAV, transactions or equal ID-less deposits', () => {
    const fund = { date: '20260105', reportDate: '20260105', amount: '25', activityCode: 'DEP', levelOfDetail: 'BaseCurrency' };
    const stmt = statement({ StmtFunds: { StatementOfFundsLine: [fund, { ...fund }] } });
    const parsed = extractSeries([stmt, structuredClone(stmt)]);
    assert.equal(parsed.nav[0].nav, 100);
    assert.deepEqual(parsed.flows, [{ date: '20260105', amount: 50 }]);
    assert.deepEqual(parsed.accountIds, ['TEST']);
});

test('invalid/future NAV and conflicting overlapping rows cannot be silently summed', () => {
    assert.throws(() => extractSeries([statement({ EquitySummaryInBase: { EquitySummaryByReportDateInBase: { currency: 'CZK', reportDate: '20260230', total: '50' } } })]), /datum/);
    assert.throws(() => extractSeries([statement({ EquitySummaryInBase: { EquitySummaryByReportDateInBase: { currency: 'CZK', reportDate: '20990101', total: '50' } } })]), /datum/);
    const changed = statement();
    changed.EquitySummaryInBase.EquitySummaryByReportDateInBase[0].total = '999';
    assert.throws(() => extractSeries([statement(), changed]), /rozdílné NAV/);
});

test('parser fills FX only from earlier dates and supports USD identity rates', () => {
    const parsed = extractSeries([statement({ ConversionRates: { ConversionRate: [{ fromCurrency: 'USD', toCurrency: 'CZK', reportDate: '20260103', rate: '24' }] } })]);
    assert.equal(parsed.fxToUsd['20260102'], undefined);
    assert.equal(parsed.fxToUsd['20260105'], 24);
    const usd = statement({ AccountInformation: { currency: 'USD' }, ConversionRates: {} });
    usd.EquitySummaryInBase.EquitySummaryByReportDateInBase.forEach(n => n.currency = 'USD');
    assert.deepEqual(extractSeries([usd]).fxToUsd, { '20260102': 1, '20260105': 1, '20260106': 1 });
});

test('position transfers are external capital; explicit empty sections are valid', () => {
    assert.deepEqual(extractSeries([statement()]).warnings, []);
    const result = extractSeries([statement({ Transfers: { Transfer: { date: '20260105', direction: 'IN', assetCategory: 'STK', positionAmountInBase: '500' } } })]);
    assert.deepEqual(result.flows, [{ date: '20260105', amount: 500 }]);
});

test('passive ledger recognizes FIFO sale gains and dividend reinvestment basis separately', () => {
    const result = simulatePassiveLedger({
        flows: [{ date: '20260106', amount: -110 }], prices: { '20260102': 10, '20260105': 11, '20260106': 11 }, dividends: { '20260105': 1 },
        fxToBase: { '20260102': 1 }, from: '20260102', to: '20260106', startValue: 100, dividendRate: 0.15, liquidate: true,
    })!;
    close(result.dividendIncomeByYear['2026'], 10);
    close(result.value, 8.5);
    close(result.trades.reduce((sum, t) => sum + t.pnl, 0), 10);
    assert.equal(result.trades.at(-1)!.acquiredDate, '20260105');
});
