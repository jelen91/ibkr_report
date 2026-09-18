import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SELF_EMPLOYED, DEFAULT_TAX_SETTINGS, benchmarkTax, computeSelfEmployed, computeTax, getTaxYearRules, passesTimeTest, taxLiabilityByDate, taxSettingsForYear, type RealizedTrade, type TaxInputs } from '../app/lib/tax';

const inputs = (trades: RealizedTrade[] = []): TaxInputs => ({ trades, unrealized: [], dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] });
const trade = (values: Partial<RealizedTrade> = {}): RealizedTrade => ({ date: '20260917', assetCategory: 'STK', pnl: 10_000, proceeds: 150_000, holdingDays: 30, ...values });
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('100k test includes old exempt sales before testing recent sales', () => {
    const result = computeTax(inputs([trade({ pnl: 50_000, proceeds: 200_000, acquiredDate: '20200101' }), trade({ pnl: 10_000, proceeds: 50_000 })]), DEFAULT_TAX_SETTINGS)[0];
    assert.equal(result.buckets.securities.exemptGain, 50_000);
    assert.equal(result.buckets.securities.taxable, 10_000);
    assert.equal(result.buckets.securities.proceeds, 250_000);
    assert.equal(result.totalTax, 1_500);
    assert.equal(result.grossIncome, 50_000);
});

test('value-exempt proceeds cannot break flat tax regime', () => {
    const result = computeTax(inputs([trade({ proceeds: 90_000, holdingDays: null })]), DEFAULT_TAX_SETTINGS)[0];
    assert.equal(result.grossIncome, 0);
    assert.equal(result.totalTax, 0);
    assert.equal(result.unknownHoldingPnl, 0);
});

test('holding test follows calendar anniversaries across leap years', () => {
    assert.equal(passesTimeTest(trade({ date: '20250301', acquiredDate: '20220301' })), false);
    assert.equal(passesTimeTest(trade({ date: '20250302', acquiredDate: '20220301' })), true);
    assert.equal(passesTimeTest(trade({ date: '20250228', holdingDays: 1095 })), false);
    assert.equal(passesTimeTest(trade({ date: '20270228', acquiredDate: '20240229' })), false);
    assert.equal(passesTimeTest(trade({ date: '20270301', acquiredDate: '20240229' })), true);
});

test('crypto exemption begins on 15 February 2025 and excludes earlier income from value test', () => {
    const result = computeTax(inputs([
        trade({ date: '20250101', assetCategory: 'CRYPTO', proceeds: 50_000, pnl: 10_000, acquiredDate: '20200101' }),
        trade({ date: '20250401', assetCategory: 'CRYPTO', proceeds: 80_000, pnl: 20_000 }),
    ]), DEFAULT_TAX_SETTINGS)[0];
    assert.equal(result.buckets.crypto.taxable, 10_000);
    assert.equal(result.buckets.crypto.exemptGain, 20_000);
    assert.equal(result.grossIncome, 50_000);
});

test('2025 cap applies proportionally and securities cap is removed for 2026', () => {
    const sales = inputs([trade({ date: '20250901', acquiredDate: '20200101', proceeds: 50_000_000, pnl: 10_000_000 })]);
    const y2025 = computeTax(sales, DEFAULT_TAX_SETTINGS)[0];
    close(y2025.buckets.securities.taxable, 2_000_000);
    assert.ok(y2025.warnings.length);
    sales.trades[0].date = '20260901';
    assert.equal(computeTax(sales, DEFAULT_TAX_SETTINGS)[0].totalTax, 0);
});

test('progression is resolved per calendar year, loss buckets and years stay separate', () => {
    const result = computeTax(inputs([
        trade({ date: '20250501', assetCategory: 'OPT', pnl: 100_000 }),
        trade({ date: '20260501', assetCategory: 'OPT', pnl: 100_000 }),
        trade({ date: '20260501', assetCategory: 'STK', pnl: -100_000 }),
    ]), { ...DEFAULT_TAX_SETTINGS, rateMode: 'auto', otherTaxBase: 1_650_000 });
    close(result[0].totalTax, 26_052 * .15 + 73_948 * .23);
    close(result[1].totalTax, 15_000);
    assert.equal(getTaxYearRules(2030), null);
    assert.equal(taxSettingsForYear(taxSettingsForYear(DEFAULT_TAX_SETTINGS, 2026), 2025).progressiveThreshold, 1_676_052);
});

test('dividend corrections net income and withholding needs verified credit', () => {
    const data = inputs();
    data.dividends = [{ date: '20260901', amount: 1_000 }, { date: '20260901', amount: -200 }];
    data.dividendWithheld = [{ date: '20260901', amount: -300 }];
    data.interest = [{ date: '20260901', amount: 100, kind: 'income' }, { date: '20260901', amount: -20, kind: 'income' }, { date: '20260901', amount: -30, kind: 'expense' }];
    let result = computeTax(data, DEFAULT_TAX_SETTINGS)[0];
    assert.equal(result.dividends.gross, 800);
    assert.equal(result.dividends.credit, 0);
    assert.equal(result.interest.gross, 80);
    assert.equal(result.interest.nonDeductible, 30);
    assert.equal(result.totalTax, 132);
    data.dividendWithheld[0].creditableAmount = 100;
    result = computeTax(data, DEFAULT_TAX_SETTINGS)[0];
    assert.equal(result.dividends.credit, 100);
    assert.equal(result.totalTax, 32);
});

test('tax liability includes earlier and non-trading-day events and accepts unsorted chart dates', () => {
    const data = inputs([trade({ date: '20260101', assetCategory: 'OPT', pnl: 1_000 }), trade({ date: '20260104', assetCategory: 'OPT', pnl: 2_000 })]);
    const series = taxLiabilityByDate(data, DEFAULT_TAX_SETTINGS, ['20260105', '20260102']);
    assert.equal(series['20260102'], 150);
    assert.equal(series['20260105'], 450);
});

test('self-employed social and health bases use distinct shares, minima, annual rules and social ceiling', () => {
    const result = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 1_000_000, expenseMode: 'actual', year: 2025 }, 100_000, DEFAULT_TAX_SETTINGS);
    assert.equal(result.social, 160_600);
    assert.equal(result.health, 67_500);
    assert.equal(result.incomeTax, 134_160);
    const low = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 100_000, year: 2025 }, 0, DEFAULT_TAX_SETTINGS);
    assert.equal(low.social, 57_098);
    assert.equal(low.health, 37_712);
    const low2026 = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 100_000, year: 2026 }, 0, DEFAULT_TAX_SETTINGS);
    assert.equal(low2026.social, 60_056);
    assert.equal(low2026.health, 39_664);
    const large = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 10_000_000, expenseMode: 'actual', year: 2025 }, 0, DEFAULT_TAX_SETTINGS);
    assert.equal(large.social, 652_543);
    assert.equal(large.health, 675_000);
});

test('investment marginal cost respects unused taxpayer credit', () => {
    const result = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 0, monthsActive: 0, year: 2026 }, 100_000, DEFAULT_TAX_SETTINGS);
    assert.equal(result.investmentTaxAlone, 0);
    assert.equal(result.incomeTax, 0);
});

test('benchmark value and calendar-time exemption use the same rules', () => {
    assert.equal(benchmarkTax({ startValue: 50_000, endValueBeforeCapitalTax: 90_000, sold: true, holdingDays: 10, settings: DEFAULT_TAX_SETTINGS }), 0);
    assert.equal(benchmarkTax({ startValue: 100_000, endValueBeforeCapitalTax: 150_000, sold: true, holdingDays: 1095, acquiredDate: '20220301', disposalDate: '20250301', settings: DEFAULT_TAX_SETTINGS }), 7_500);
});
