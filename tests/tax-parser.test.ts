import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRealizedTrades, extractSeries, extractUnrealizedPositions } from '../app/lib/flexPerformance';

const execution = (values: Record<string, unknown>) => ({ levelOfDetail: 'EXECUTION', tradeDate: '20260901', assetCategory: 'OPT', currency: 'USD', fxRateToBase: 22, quantity: -1, proceeds: 100, fifoPnlRealized: 0, openCloseIndicator: 'O', ...values });

test('opening sales enter gross income; closing buys contribute only realized P/L', () => {
    const result = extractRealizedTrades({ Trades: { Trade: [
        execution({}), execution({ tradeDate: '20260902', quantity: 1, proceeds: -40, fifoPnlRealized: 55, openCloseIndicator: 'C' }),
    ] } });
    assert.equal(result.length, 2);
    assert.equal(result.reduce((s, t) => s + t.proceeds, 0), 2_200);
    assert.equal(result.reduce((s, t) => s + t.pnl, 0), 1_210);
    assert.equal(result[1].exemptionEligible, false);
});

test('broker acquisition dates drive holding tests without weighted-age inference', () => {
    const result = extractRealizedTrades({ Trades: { Trade: [
        execution({ assetCategory: 'STK', openCloseIndicator: 'C', fifoPnlRealized: 10, openDateTime: '20220901;120000' }),
        execution({ assetCategory: 'STK', openCloseIndicator: 'C', fifoPnlRealized: 20 }),
        execution({ levelOfDetail: 'CLOSED_LOT', fifoPnlRealized: 10 }),
    ] } });
    assert.equal(result.length, 2);
    assert.equal(result[0].acquiredDate, '20220901');
    assert.equal(result[0].holdingDays, 1461);
    assert.equal(result[1].holdingDays, null);
    assert.equal(result.reduce((s, t) => s + t.pnl, 0), 660);
});

test('missing monetary inputs fail visibly rather than becoming zero or a 1:1 FX conversion', () => {
    assert.throws(() => extractRealizedTrades({ Trades: { Trade: execution({ fxRateToBase: '' }) } }), /kurz/);
    assert.throws(() => extractRealizedTrades({ Trades: { Trade: execution({ proceeds: '' }) } }), /příjem/);
    assert.throws(() => extractRealizedTrades({ Trades: { Trade: execution({ tradeDate: '20260230' }) } }), /datum/);
});

test('a trade in the declared base currency needs no currency conversion', () => {
    const result = extractRealizedTrades({ AccountInformation: { currency: 'USD' }, Trades: { Trade:
        execution({ fxRateToBase: '', fifoPnlRealized: 10, openCloseIndicator: 'C' }),
    } });
    assert.equal(result[0].pnl, 10);
    assert.equal(result[0].proceeds, 100);
});

test('order and multiple closed-lot levels do not duplicate or conflict with executions', () => {
    const result = extractSeries([{
        accountId: 'TEST', fromDate: '20260901', toDate: '20260901', AccountInformation: { currency: 'USD' },
        EquitySummaryInBase: { EquitySummaryByReportDateInBase: { reportDate: '20260901', total: 1000, currency: 'USD' } },
        StmtFunds: {}, Transfers: {}, OpenPositions: {},
        Trades: { Trade: [
            execution({ tradeID: '1', fifoPnlRealized: 10, openCloseIndicator: 'C' }),
            execution({ tradeID: '1', levelOfDetail: 'ORDER', fifoPnlRealized: 10 }),
            execution({ tradeID: '1', levelOfDetail: 'CLOSED_LOT', fifoPnlRealized: 4, openDateTime: '20220101;120000' }),
            execution({ tradeID: '1', levelOfDetail: 'CLOSED_LOT', fifoPnlRealized: 6, openDateTime: '20260101;120000' }),
        ] },
    }]);
    assert.equal(result.tax.trades.length, 1);
    assert.equal(result.tax.trades[0].pnl, 10);
});

const position = (values: Record<string, unknown> = {}) => ({
    levelOfDetail: 'SUMMARY', reportDate: '20260901', assetCategory: 'STK', conid: '1', symbol: 'TEST',
    currency: 'USD', fxRateToBase: 22, position: 10, positionValue: 100, fifoPnlUnrealized: 30,
    ...values,
});

test('complete open lots replace their summary and preserve each acquisition date', () => {
    const result = extractUnrealizedPositions([
        position(),
        position({ levelOfDetail: 'LOT', position: 4, positionValue: 40, fifoPnlUnrealized: 20, openDateTime: '20200101;120000' }),
        position({ levelOfDetail: 'LOT', position: 6, positionValue: 60, fifoPnlUnrealized: 10, openDateTime: '20260801;120000' }),
    ], 'CZK', '20260901');
    assert.equal(result.length, 2);
    assert.equal(result.reduce((s, row) => s + row.proceeds, 0), 2200);
    assert.equal(result.reduce((s, row) => s + row.pnl, 0), 660);
    assert.deepEqual(result.map(row => row.acquiredDate), ['20200101', '20260801']);
    assert.equal(result[1].holdingDays, 31);
});

test('lot-only reports retain liquidation value, while summaries do not infer average holding periods', () => {
    const result = extractUnrealizedPositions([
        position({ levelOfDetail: 'LOT', openDateTime: '20200101;120000', reportDate: '' }),
    ], 'USD', '20260901');
    assert.equal(result[0].pnl, 30);
    assert.equal(result[0].date, '20260901');
    assert.equal(result[0].acquiredDate, '20200101');
    const summary = extractUnrealizedPositions([position({ openDateTime: '20200101;120000' })], 'USD', '20260901');
    assert.equal(summary[0].holdingDays, null);
});

test('a short liquidation cannot obtain a holding-period or proceeds exemption', () => {
    const result = extractUnrealizedPositions([
        position({ levelOfDetail: 'LOT', position: -10, positionValue: -100, openDateTime: '20200101;120000' }),
    ], 'CZK', '20260901');
    assert.equal(result[0].exemptionEligible, false);
    assert.equal(result[0].proceeds, 0);
    assert.equal(result[0].holdingDays, null);
    assert.equal(result[0].acquiredDate, undefined);
});

test('incomplete lots and duplicate position summaries fail instead of omitting or doubling tax', () => {
    assert.throws(() => extractUnrealizedPositions([
        position(), position({ levelOfDetail: 'LOT', position: 4, positionValue: 40, fifoPnlUnrealized: 20 }),
    ], 'CZK', '20260901'), /nesouhlasí/);
    assert.throws(() => extractUnrealizedPositions([position(), position()], 'CZK', '20260901'), /více souhrnů/);
    assert.throws(() => extractUnrealizedPositions([position({ fxRateToBase: '' })], 'CZK', '20260901'), /kurzu/);
});
