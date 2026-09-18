import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeAfterTaxComparison, DEFAULT_AFTER_TAX_YEAR_SETTINGS,
    type AfterTaxComparisonOptions, type AfterTaxYearSettings,
} from '../app/lib/afterTaxComparison';
import { computeSelfEmployed, DEFAULT_SELF_EMPLOYED, DEFAULT_TAX_SETTINGS } from '../app/lib/tax';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const settings: AfterTaxYearSettings = { ...DEFAULT_AFTER_TAX_YEAR_SETTINGS, taxpayerCredit: 0 };
const basic = (): AfterTaxComparisonOptions => ({
    nav: [{ date: '20260102', nav: 1_000_000 }, { date: '20260105', nav: 1_100_000 }],
    flows: [], fxToUsd: { '20260102': 1, '20260105': 1 },
    prices: { '20260102': 100, '20260105': 110 }, dividends: {},
    from: '20260102', to: '20260105',
    tax: { trades: [], unrealized: [], dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] },
    distributing: false, liquidationMode: 'none', annualSettings: { '2026': { ...settings } },
    foreignCredit: 'capped15', foreignIncomeMode: 'separate15',
});
const option = (date: string, pnl: number, proceeds = Math.max(0, pnl)) => ({
    date, assetCategory: 'OPT', pnl, proceeds, holdingDays: null,
});

test('realized trading taxes produce a usable verdict despite model warnings; input remains unchanged', () => {
    const opts = basic();
    opts.tax.trades = [option('20260105', 100_000)];
    const before = structuredClone(opts);
    const result = computeAfterTaxComparison(opts);
    near(result.trading.net, 1_085_000);
    near(result.passive.net, 1_100_000);
    near(result.delta, -15_000);
    assert.ok(result.warnings.length > 0);
    assert.deepEqual(opts, before);
    near(result.points[0].tradingNet, result.points[0].passiveNet);
});

test('same opening NAV and end-of-day cashflows apply to both strategies without double initial deposits', () => {
    const opts = basic();
    opts.flows = [{ date: '20260102', amount: 1_000_000 }, { date: '20260105', amount: 220_000 }];
    opts.nav[1].nav = 1_320_000;
    const result = computeAfterTaxComparison(opts);
    near(result.passive.gross, 1_320_000);
    near(result.delta, 0);
});

test('withdrawals realize FIFO taxable ETF gains even with no terminal liquidation', () => {
    const opts = basic();
    opts.flows = [{ date: '20260105', amount: -220_000 }];
    opts.nav[1].nav = 880_000;
    const result = computeAfterTaxComparison(opts);
    near(result.passive.gross, 880_000);
    near(result.passive.investmentTax, 3_000);
    near(result.passive.net, 877_000);
});

test('terminal liquidation affects both terminal totals, never the realized-tax history', () => {
    const opts = basic();
    opts.liquidationMode = 'both';
    opts.tax.unrealized = [{ date: '20260105', assetCategory: 'STK', pnl: 100_000, proceeds: 1_100_000, holdingDays: null }];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.net, 1_085_000);
    near(result.passive.net, 1_085_000);
    near(result.points.at(-1)!.tradingNet, 1_100_000);
    near(result.points.at(-1)!.passiveNet, 1_100_000);
    near(result.delta, 0);
});

test('terminal liquidation requires a contemporaneous snapshot for every open position', () => {
    const opts = basic();
    opts.tax.unrealized = [{ date: '20260102', assetCategory: 'STK', pnl: 100_000, proceeds: 1_100_000, holdingDays: null }];
    assert.doesNotThrow(() => computeAfterTaxComparison(opts));
    for (const liquidationMode of ['ibkr', 'both'] as const) {
        opts.liquidationMode = liquidationMode;
        for (const date of ['20260102', '20260106']) {
            opts.tax.unrealized[0].date = date;
            assert.throws(() => computeAfterTaxComparison(opts), /aktuální ocenění/);
        }
    }
});

test('IBKR-only liquidation taxes trading positions while leaving the held index and history unchanged', () => {
    const opts = basic();
    opts.tax.unrealized = [{ date: '20260105', assetCategory: 'STK', pnl: 100_000, proceeds: 1_100_000, holdingDays: null }];
    const held = computeAfterTaxComparison(opts);
    const ibkr = computeAfterTaxComparison({ ...opts, liquidationMode: 'ibkr' });
    const both = computeAfterTaxComparison({ ...opts, liquidationMode: 'both' });
    assert.deepEqual(ibkr.trading, both.trading);
    assert.deepEqual(ibkr.passive, held.passive);
    assert.deepEqual(ibkr.annual[0].trading, both.annual[0].trading);
    assert.deepEqual(ibkr.annual[0].passive, held.annual[0].passive);
    assert.deepEqual(ibkr.points, held.points);
    assert.deepEqual(ibkr.points, both.points);
    near(ibkr.trading.investmentTax, 15_000);
    near(ibkr.passive.investmentTax, 0);
    near(ibkr.delta, -15_000);
    assert.ok(ibkr.warnings.some(warning => /pouze portfolia IBKR/.test(warning)));
    assert.ok(ibkr.warnings.some(warning => /Nejde o potvrzení časového osvobození/.test(warning)));
});

test('IBKR-only liquidation preserves passive withdrawal and dividend tax plus its flat-regime cost', () => {
    const opts = basic();
    opts.annualSettings['2026'] = { ...settings, flatTaxRegime: true, businessIncome: 1_500_000,
        otherTaxBase: 600_000, taxpayerCredit: 30_840 };
    opts.flows = [{ date: '20260105', amount: -220_000 }];
    opts.nav[1].nav = 897_000;
    opts.distributing = true;
    opts.dividends = { '20260105': 2 };
    opts.foreignCredit = 'none';
    opts.tax.unrealized = [option('20260105', 100_000)];
    const held = computeAfterTaxComparison(opts);
    const ibkr = computeAfterTaxComparison({ ...opts, liquidationMode: 'ibkr' });
    const both = computeAfterTaxComparison({ ...opts, liquidationMode: 'both' });
    assert.deepEqual(ibkr.trading, both.trading);
    assert.deepEqual(ibkr.passive, held.passive);
    assert.deepEqual(ibkr.annual[0].passive, held.annual[0].passive);
    assert.deepEqual(ibkr.points, held.points);
    assert.equal(ibkr.annual[0].passive.flatTaxBroken, true);
    assert.ok(ibkr.passive.regimeCost > 0);
    near(ibkr.passive.investmentTax, 6_000); // 20,000 ETF sale gain plus 20,000 gross dividends.
    near(ibkr.passive.withheld, 3_000);
    assert.ok(both.passive.investmentTax > ibkr.passive.investmentTax);
});

test('IBKR-only liquidation releases a shared prior tax reserve when open option losses are realized', () => {
    const opts = basic();
    opts.tax.trades = [option('20260101', 100_000)];
    opts.tax.unrealized = [option('20260105', -100_000)];
    opts.nav[1].nav = 900_000;
    opts.prices['20260105'] = 90;
    const held = computeAfterTaxComparison(opts);
    const ibkr = computeAfterTaxComparison({ ...opts, liquidationMode: 'ibkr' });
    const both = computeAfterTaxComparison({ ...opts, liquidationMode: 'both' });
    near(ibkr.trading.investmentTax, -15_000);
    near(ibkr.trading.net, 915_000);
    near(ibkr.delta, 15_000);
    assert.deepEqual(ibkr.trading, both.trading);
    assert.deepEqual(ibkr.passive, held.passive);
    assert.deepEqual(ibkr.points, held.points);
    near(ibkr.points.at(-1)!.tradingNet, 900_000);
});

test('shared annual prefix preserves earlier losses for both counterfactuals', () => {
    const opts = basic();
    opts.tax.trades = [option('20260101', -100_000), option('20260105', 100_000)];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 0);
    near(result.delta, 0);
    opts.tax.trades = [option('20260101', 100_000), option('20260105', -100_000)];
    opts.nav[1].nav = 900_000;
    opts.prices['20260105'] = 90;
    const refunded = computeAfterTaxComparison(opts);
    near(refunded.trading.investmentTax, -15_000);
    near(refunded.passive.investmentTax, 0);
    near(refunded.delta, 15_000);
});

test('annual gross-sale value tests include the shared prefix', () => {
    const opts = basic();
    opts.tax.trades = [{ date: '20260101', assetCategory: 'STK', pnl: 10_000, proceeds: 80_000, holdingDays: null }];
    opts.flows = [{ date: '20260105', amount: -55_000 }];
    opts.nav[1].nav -= 55_000;
    const result = computeAfterTaxComparison(opts);
    // Current ETF sale gains 5,000; adding 55,000 sales revokes the prefix's
    // value exemption too, so the incremental reserve is (10,000+5,000)*15%.
    near(result.passive.investmentTax, 2_250);
});

test('annual tax years do not offset losses and use their respective progression thresholds', () => {
    const opts = basic();
    opts.from = '20251229'; opts.to = '20260105';
    opts.nav = [{ date: '20251229', nav: 1_000_000 }, { date: '20251230', nav: 1_100_000 }, { date: '20260105', nav: 1_000_000 }];
    opts.prices = { '20251229': 100, '20251230': 110, '20260105': 100 };
    opts.fxToUsd = { '20251229': 1, '20251230': 1, '20260105': 1 };
    opts.annualSettings['2025'] = { ...settings, otherTaxBase: 1_660_000 };
    opts.annualSettings['2026'] = { ...settings, otherTaxBase: 1_660_000 };
    opts.tax.trades = [option('20251230', 100_000), option('20260105', -100_000)];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 16_052 * 0.15 + 83_948 * 0.23);
    assert.equal(result.annual.length, 2);
});

test('separate foreign dividends get 15% and capped credit once; personal credit cannot erase their tax', () => {
    const opts = basic();
    opts.nav[1].nav = 1_083_000;
    opts.prices['20260105'] = 100;
    opts.dividends = { '20260105': 10 };
    opts.distributing = true;
    opts.tax.dividends = [{ date: '20260105', amount: 100_000 }];
    opts.tax.dividendWithheld = [{ date: '20260105', amount: -17_000 }];
    opts.annualSettings['2026'] = { ...settings, otherTaxBase: 3_000_000 };
    const credited = computeAfterTaxComparison(opts);
    near(credited.trading.investmentTax, 0);
    near(credited.trading.withheld, 17_000);
    near(credited.passive.gross, 1_085_000);
    near(credited.passive.investmentTax, 0);
    near(credited.annual[0].trading.foreignCredit, 15_000);
    opts.foreignCredit = 'none';
    opts.annualSettings['2026'] = { ...settings, taxpayerCredit: 30_840 };
    const noCredit = computeAfterTaxComparison(opts);
    near(noCredit.trading.investmentTax, 15_000);
    near(noCredit.passive.investmentTax, 15_000);
    near(noCredit.passive.net, 1_070_000);
});

test('progressive dividend scenario and personal unused credit are applied explicitly', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'progressive';
    opts.foreignCredit = 'none';
    opts.tax.dividends = [{ date: '20260105', amount: 100_000 }];
    opts.annualSettings['2026'] = { ...settings, otherTaxBase: 3_000_000 };
    near(computeAfterTaxComparison(opts).trading.investmentTax, 23_000);
    opts.annualSettings['2026'] = { ...settings, taxpayerCredit: 30_840, otherTaxBase: 150_000 };
    // Other income consumes 22,500 of the credit, leaving 8,340 for investment income.
    near(computeAfterTaxComparison(opts).trading.investmentTax, 6_660);
});

test('automatic dividend taxation uses unused personal credit without crediting foreign withholding twice', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'auto';
    opts.foreignCredit = 'dividends15';
    opts.tax.dividends = [{ date: '20260105', amount: 100_000 }];
    opts.tax.dividendWithheld = [{ date: '20260105', amount: -10_000 }];
    opts.annualSettings['2026'] = { ...settings, taxpayerCredit: 30_840 };
    const before = structuredClone(opts);
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 0);
    near(result.annual[0].trading.foreignCredit, 0);
    near(result.trading.withheld, 10_000); // Already in NAV; no additional refund or deduction.
    assert.equal(result.annual[0].trading.dividendTaxMode, 'progressive');
    near(computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'separate15' }).trading.investmentTax, 5_000);
    assert.deepEqual(opts, before);
});

test('automatic dividend taxation chooses 15% at high income but does not expand interest credit eligibility', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'auto';
    opts.foreignCredit = 'dividends15';
    opts.annualSettings['2026'] = { ...settings, otherTaxBase: 3_000_000, taxpayerCredit: 30_840 };
    opts.tax.dividends = [{ date: '20260105', amount: 100_000 }];
    opts.tax.dividendWithheld = [{ date: '20260105', amount: -17_000 }];
    opts.tax.interest = [{ date: '20260105', amount: 20_000, kind: 'income' }];
    opts.tax.interestWithheld = [{ date: '20260105', amount: -4_000 }];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 4_600);
    near(result.annual[0].trading.foreignCredit, 15_000);
    near(result.trading.withheld, 21_000);
    assert.equal(result.annual[0].trading.dividendTaxMode, 'separate15');
    assert.deepEqual(result.trading, computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'separate15' }).trading);
    assert.ok(result.trading.investmentTax < computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'progressive' }).trading.investmentTax);
});

test('automatic selection is deterministic for the 1.5m revenue / 60% expenses profile and preserves flat-tax treatment', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'auto';
    opts.foreignCredit = 'dividends15';
    opts.annualSettings['2026'] = { ...settings, businessIncome: 1_500_000, expenseRate: 0.6,
        otherTaxBase: 600_000, flatTaxRegime: true, taxpayerCredit: 30_840 };
    opts.tax.trades = [option('20260105', 100_000)];
    opts.tax.dividends = [{ date: '20260105', amount: 10_000 }];
    opts.tax.dividendWithheld = [{ date: '20260105', amount: -1_500 }];
    opts.tax.interest = [{ date: '20260105', amount: 20_000, kind: 'income' }];
    opts.tax.interestWithheld = [{ date: '20260105', amount: -4_000 }];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 18_000);
    assert.equal(result.annual[0].trading.dividendTaxMode, 'separate15');
    assert.deepEqual(result.trading, computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'separate15' }).trading);
    assert.deepEqual(result.trading, computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'progressive' }).trading);
    opts.tax.trades = [];
    const intact = computeAfterTaxComparison(opts);
    near(intact.trading.totalCost, 0);
    near(intact.annual[0].trading.foreignCredit, 0);
    assert.equal(intact.annual[0].trading.flatTaxBroken, false);
});

test('automatic selection treats each strategy and each tax year independently', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'auto';
    opts.foreignCredit = 'dividends15';
    opts.distributing = true;
    opts.prices['20260105'] = 100;
    opts.dividends = { '20260105': 10 };
    opts.tax.dividends = [{ date: '20260105', amount: 100_000 }];
    opts.annualSettings['2026'] = { ...settings, otherTaxBase: 150_000, taxpayerCredit: 30_840 };
    const oneYear = computeAfterTaxComparison(opts);
    near(oneYear.trading.investmentTax, 6_660);
    near(oneYear.passive.investmentTax, 0);
    assert.equal(oneYear.annual[0].trading.dividendTaxMode, 'progressive');
    assert.equal(oneYear.annual[0].passive.dividendTaxMode, 'separate15');

    opts.from = '20251229';
    opts.nav = [{ date: '20251229', nav: 1_000_000 }, { date: '20251230', nav: 1_100_000 }, ...opts.nav];
    opts.prices = { ...opts.prices, '20251229': 100, '20251230': 100 };
    opts.fxToUsd = { ...opts.fxToUsd, '20251229': 1, '20251230': 1 };
    opts.annualSettings['2025'] = { ...settings, otherTaxBase: 3_000_000, taxpayerCredit: 30_840 };
    opts.tax.dividends.push({ date: '20251230', amount: 100_000 });
    const bothYears = computeAfterTaxComparison(opts);
    near(bothYears.trading.investmentTax, 15_000 + 6_660);
    assert.equal(bothYears.annual[0].trading.dividendTaxMode, 'separate15');
    assert.equal(bothYears.annual[1].trading.dividendTaxMode, 'progressive');
});

test('automatic annual selection subtracts the independently optimized shared prefix even when the best mode changes', () => {
    const opts = basic();
    opts.foreignIncomeMode = 'auto';
    opts.foreignCredit = 'none';
    opts.annualSettings['2026'] = { ...settings, taxpayerCredit: 30_840 };
    opts.tax.dividends = [{ date: '20260101', amount: 100_000 }];
    opts.tax.trades = [option('20260105', 2_000_000)];
    const result = computeAfterTaxComparison(opts);
    assert.equal(result.annual[0].prefix.dividendTaxMode, 'progressive');
    assert.equal(result.annual[0].trading.dividendTaxMode, 'separate15');
    near(result.annual[0].prefix.investmentTax, 0);
    near(result.trading.investmentTax, result.annual[0].trading.investmentTax);
    near(result.passive.investmentTax, 0);
    near(result.trading.investmentTax,
        computeAfterTaxComparison({ ...opts, foreignIncomeMode: 'separate15' }).trading.investmentTax + 15_000);
    near(result.points[0].tradingNet, result.points[0].passiveNet);
});

test('dividend-only credit does not silently credit Irish broker interest withholding', () => {
    const opts = basic();
    opts.foreignCredit = 'dividends15';
    opts.tax.dividends = [{ date: '20260105', amount: 10_000 }];
    opts.tax.dividendWithheld = [{ date: '20260105', amount: -1_500 }];
    opts.tax.interest = [{ date: '20260105', amount: 20_000, kind: 'income' }];
    opts.tax.interestWithheld = [{ date: '20260105', amount: -4_000 }];
    const result = computeAfterTaxComparison(opts);
    near(result.trading.investmentTax, 3_000);
    near(result.trading.withheld, 5_500);
    near(result.annual[0].trading.foreignCredit, 1_500);
    opts.foreignCredit = 'capped15';
    near(computeAfterTaxComparison(opts).trading.investmentTax, 0);
});

test('flat-tax regime loss charges incremental annual business cost once and preserves inherited loss of eligibility', () => {
    const opts = basic();
    const year = { ...settings, businessIncome: 1_500_000, otherTaxBase: 600_000,
        flatTaxRegime: true, taxpayerCredit: 30_840, expenseRate: 0.6, flatTaxMonthly: 9_162 };
    opts.annualSettings['2026'] = year;
    opts.tax.trades = [option('20260105', 100_000)];
    const result = computeAfterTaxComparison(opts);
    const expectedBase = computeSelfEmployed({ ...DEFAULT_SELF_EMPLOYED, income: 1_500_000,
        expenseRate: 0.6, flatTaxPaid: 9_162 * 12, year: 2026 }, 0,
    { ...DEFAULT_TAX_SETTINGS, rateMode: 'auto', otherTaxBase: 600_000, taxYear: 2026 });
    near(result.trading.regimeCost, expectedBase.totalDue - 9_162 * 12);
    near(result.trading.investmentTax, 15_000);
    near(result.passive.totalCost, 0);
    opts.tax.trades.unshift(option('20260101', 0, 100_000));
    const inherited = computeAfterTaxComparison(opts);
    near(inherited.trading.regimeCost, 0);
    near(inherited.passive.regimeCost, 0);
    near(inherited.trading.investmentTax, 15_000);
});

test('SPY distributions can break flat regime even without selling ETF; prefix income counts', () => {
    const opts = basic();
    opts.annualSettings['2026'] = { ...settings, flatTaxRegime: true, businessIncome: 1_500_000,
        otherTaxBase: 600_000, taxpayerCredit: 30_840 };
    opts.tax.interest = [{ date: '20260101', amount: 45_000, kind: 'income' }];
    opts.distributing = true;
    opts.dividends = { '20260105': 1 };
    const result = computeAfterTaxComparison(opts);
    assert.equal(result.annual[0].prefix.flatTaxBroken, false);
    assert.equal(result.annual[0].trading.flatTaxBroken, false);
    assert.equal(result.annual[0].passive.flatTaxBroken, true);
    assert.ok(result.passive.regimeCost > 0);
    near(result.passive.investmentTax, 6_750); // shared interest becomes taxable, dividend credit handles SPY.
});

test('missing data and unaffordable passive withdrawals are errors, not plausible numerical results', () => {
    const opts = basic();
    delete opts.fxToUsd['20260105'];
    assert.throws(() => computeAfterTaxComparison(opts), /kurz/);
    opts.fxToUsd['20260105'] = 1;
    opts.flows = [{ date: '20260105', amount: -2_000_000 }];
    assert.throws(() => computeAfterTaxComparison(opts), /výběry/);
});
