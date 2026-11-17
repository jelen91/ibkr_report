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

// Real reports list closed lots as <Lot> elements next to the closing executions.
const fill = (values: Record<string, unknown>) => execution({ assetCategory: 'STK', conid: '7', dateTime: '20260901;153000',
    buySell: 'SELL', openCloseIndicator: 'C', ...values });
const closedLot = (values: Record<string, unknown>) => ({ levelOfDetail: 'CLOSED_LOT', assetCategory: 'STK', conid: '7',
    currency: 'USD', fxRateToBase: 22, dateTime: '20260901;153000', tradeDate: '20260901', buySell: 'SELL', ...values });

test('closed lots split partial fills by acquisition date and carry purchase prices for the Czech conversion', () => {
    const rates: Record<string, number> = { '20220301': 23, '20260302': 20 };
    const result = extractRealizedTrades({ AccountInformation: { currency: 'CZK' }, Trades: {
        Trade: [fill({ tradeID: '1', quantity: -4, proceeds: 400, fifoPnlRealized: 50 }), fill({ tradeID: '2', quantity: -6, proceeds: 600, fifoPnlRealized: 70 })],
        Lot: [closedLot({ quantity: 3, cost: 300, fifoPnlRealized: 100, openDateTime: '20220301;100000' }),
            closedLot({ quantity: 7, cost: 580, fifoPnlRealized: 20, openDateTime: '20260302;100000' })],
    } }, (currency, date) => currency === 'USD' ? rates[date] : undefined);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(t => t.acquiredDate), ['20220301', '20260302']);
    assert.deepEqual(result.map(t => t.proceeds), [300 * 22, 700 * 22]);
    assert.deepEqual(result.map(t => t.pnl), [100 * 22, 20 * 22]);
    assert.deepEqual(result[0].lot, { currency: 'USD', pnl: 100, cost: 300, openDate: '20220301', closeFx: 22, openFx: 23 });
    assert.equal(result[1].lot!.openFx, 20);
});

test('a buy closing a short lot is never exempt; lots that do not reconcile fall back to the executions', () => {
    const short = extractRealizedTrades({ AccountInformation: { currency: 'CZK' }, Trades: {
        Trade: fill({ buySell: 'BUY', assetCategory: 'OPT', quantity: 1, proceeds: -20, fifoPnlRealized: 30 }),
        Lot: closedLot({ buySell: 'BUY', assetCategory: 'OPT', quantity: -1, cost: -50, fifoPnlRealized: 30, openDateTime: '20260801;100000' }),
    } });
    assert.equal(short[0].exemptionEligible, false);
    assert.equal(short[0].acquiredDate, undefined);
    assert.equal(short[0].lot!.cost, -50);
    assert.equal(short[0].lot!.openFx, undefined);
    const mismatched = extractRealizedTrades({ AccountInformation: { currency: 'CZK' }, Trades: {
        Trade: fill({ quantity: -10, proceeds: 1000, fifoPnlRealized: 120 }),
        Lot: closedLot({ quantity: 10, cost: 880, fifoPnlRealized: 100, openDateTime: '20260302;100000' }),
    } });
    assert.equal(mismatched.length, 1);
    assert.equal(mismatched[0].lot, undefined);
    assert.equal(mismatched[0].pnl, 120 * 22);
});

test('an execution that also opens a position keeps its opening part next to the closed lots', () => {
    const result = extractRealizedTrades({ AccountInformation: { currency: 'CZK' }, Trades: {
        Trade: fill({ quantity: -10, proceeds: 1000, fifoPnlRealized: 40, openCloseIndicator: 'C;O' }),
        Lot: closedLot({ quantity: 4, cost: 360, fifoPnlRealized: 40, openDateTime: '20260302;100000' }),
    } });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(t => t.proceeds), [400 * 22, 600 * 22]);
    assert.equal(result[1].pnl, 0);
    assert.equal(result[1].exemptionEligible, false);
});

test('statements attach purchase-day rates and month-end rates; overlapping statements do not duplicate lots', () => {
    const stmt = {
        accountId: 'TEST', fromDate: '20260301', toDate: '20260901', AccountInformation: { currency: 'CZK' },
        EquitySummaryInBase: { EquitySummaryByReportDateInBase: [{ reportDate: '20260301', total: '1000', currency: 'CZK' }, { reportDate: '20260901', total: '2000', currency: 'CZK' }] },
        StmtFunds: {}, Transfers: {}, OpenPositions: {},
        ConversionRates: { ConversionRate: [
            { fromCurrency: 'USD', toCurrency: 'CZK', reportDate: '20260301', rate: '20' },
            { fromCurrency: 'USD', toCurrency: 'CZK', reportDate: '20260331', rate: '21' },
            { fromCurrency: 'USD', toCurrency: 'CZK', reportDate: '20260901', rate: '22' },
        ] },
        Trades: { Trade: fill({ tradeID: '1', transactionID: '11', quantity: -10, proceeds: 1000, fifoPnlRealized: 120 }),
            // Saturday purchase uses the latest earlier rate.
            Lot: closedLot({ transactionID: '5', quantity: 10, cost: 880, fifoPnlRealized: 120, openDateTime: '20260307;100000' }) },
    };
    const result = extractSeries([stmt, structuredClone(stmt)]);
    assert.equal(result.tax.trades.length, 1);
    assert.equal(result.tax.trades[0].lot!.openFx, 20);
    assert.deepEqual(result.monthEndFx, { USD: { '202603': 21, '202609': 22 } });
});

test('open position lots carry their cost basis and purchase-day rate; summaries do not', () => {
    const [lot] = extractUnrealizedPositions([
        position({ levelOfDetail: 'LOT', costBasisMoney: 70, openDateTime: '20260301;120000' }),
    ], 'CZK', '20260901', (currency, date) => currency === 'USD' && date === '20260301' ? 20 : undefined);
    assert.deepEqual(lot.lot, { currency: 'USD', pnl: 30, cost: 70, openDate: '20260301', closeFx: 22, openFx: 20 });
    const [summary] = extractUnrealizedPositions([position({ costBasisMoney: 70 })], 'CZK', '20260901', () => 20);
    assert.equal(summary.lot, undefined);
});
