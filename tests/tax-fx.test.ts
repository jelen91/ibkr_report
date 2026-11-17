import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFxMethod, dailyPnl, mergeMonthEndFx, uniformRate } from '../app/lib/taxFx';
import type { RealizedTrade, TaxInputs } from '../app/lib/tax';

const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-7, `${value} != ${expected}`);
const inputs = (trades: RealizedTrade[], unrealized: RealizedTrade[] = []): TaxInputs =>
    ({ trades, unrealized, dividends: [], dividendWithheld: [], interest: [], interestWithheld: [] });

// Bought 1 share for 100 USD at 20 CZK/USD, sold for 110 USD at 22 CZK/USD.
const longLot = (values: Partial<RealizedTrade> = {}): RealizedTrade => ({
    date: '20260601', assetCategory: 'STK', pnl: 10 * 22, proceeds: 110 * 22, holdingDays: 120, acquiredDate: '20260201',
    lot: { currency: 'USD', pnl: 10, cost: 100, openDate: '20260201', closeFx: 22, openFx: 20 }, ...values,
});
const monthEndFx = { USD: { '202601': 21, '202602': 23, '202603': 99 } };

test('daily rates value the purchase at its own day: sale in CZK minus purchase in CZK', () => {
    near(dailyPnl(longLot()), 110 * 22 - 100 * 20);
    // Short option: premium 50 USD received at 20, bought back for 20 USD at 22.
    const short = longLot({ pnl: 30 * 22, proceeds: 0, lot: { currency: 'USD', pnl: 30, cost: -50, openDate: '20260201', closeFx: 22, openFx: 20 } });
    near(dailyPnl(short), 50 * 20 - 20 * 22);
    const converted = applyFxMethod(inputs([longLot()]), 'daily', undefined, '20260916');
    near(converted.tax.trades[0].pnl, 420);
    assert.equal(converted.converted, 1);
});

test('the uniform rate converts purchase and sale of the same year at one rate', () => {
    // March has not ended by the statement date, so it is not part of the estimate.
    const converted = applyFxMethod(inputs([longLot()]), 'uniform', monthEndFx, '20260315');
    near(converted.tax.trades[0].pnl, 10 * 22);
    near(converted.tax.trades[0].proceeds, 110 * 22);
    assert.deepEqual(converted.uniformRates, [{ year: 2026, currency: 'USD', rate: 22, official: false, months: 2 }]);
    // A purchase from 2025 keeps the official 2025 rate (NSS 2 Afs 4/2019).
    const older = longLot({ acquiredDate: '20250601', lot: { currency: 'USD', pnl: 10, cost: 100, openDate: '20250601', closeFx: 22, openFx: 20 } });
    const crossYear = applyFxMethod(inputs([older]), 'uniform', monthEndFx, '20260315');
    near(crossYear.tax.trades[0].pnl, 110 * 22 - 100 * 21.84);
});

test('a trade that cannot be converted keeps broker P/L and loses its lot marker', () => {
    const withoutOpenFx = longLot({ lot: { currency: 'USD', pnl: 10, cost: 100, openDate: '20260201', closeFx: 22 } });
    const daily = applyFxMethod(inputs([withoutOpenFx]), 'daily', undefined, '20260916');
    near(daily.tax.trades[0].pnl, 220);
    assert.equal(daily.tax.trades[0].lot, undefined);
    assert.equal(daily.fallback, 1);
    const uniform = applyFxMethod(inputs([longLot({ date: '20230601' })]), 'uniform', monthEndFx, '20260315');
    near(uniform.tax.trades[0].pnl, 220);
    assert.equal(uniform.fallback, 1);
    const base = applyFxMethod(inputs([], [longLot({ lot: { currency: 'CZK', pnl: 10, cost: 100, openDate: '20260201', closeFx: 1, openFx: 1 } })]), 'uniform', undefined, '20260916');
    near(base.tax.unrealized[0].pnl, 10);
    assert.deepEqual(base.uniformRates, []);
});

test('official uniform rates win over estimates; month-end tables merge across accounts', () => {
    assert.deepEqual(uniformRate(2025, 'USD', monthEndFx, '20260916'), { year: 2025, currency: 'USD', rate: 21.84, official: true, months: 12 });
    assert.equal(uniformRate(2026, 'CAD', monthEndFx, '20260916'), null);
    assert.equal(uniformRate(2026, 'CZK', undefined, '20260916')?.rate, 1);
    assert.deepEqual(mergeMonthEndFx([{ USD: { '202601': 21 } }, undefined, { USD: { '202602': 23 }, EUR: { '202601': 24 } }]),
        { USD: { '202601': 21, '202602': 23 }, EUR: { '202601': 24 } });
    assert.equal(mergeMonthEndFx([undefined]), undefined);
});
