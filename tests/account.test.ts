import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { parseAccountReport, mergeAccountDatas, annotatePutCommitments, accountMetric } from '../app/lib/account';
import type { AccountData, PositionItem } from '../app/types';

const position = (overrides: Record<string, unknown> = {}) => ({
    accountId: 'TEST', conid: '1', currency: 'USD', fxRateToBase: '22', assetCategory: 'STK',
    symbol: 'XYZ', reportDate: '20260916', levelOfDetail: 'SUMMARY', position: '2',
    markPrice: '10', positionValue: '20', multiplier: '1', costBasisPrice: '8', costBasisMoney: '16', fifoPnlUnrealized: '4',
    ...overrides,
});
const statement = (positions: Record<string, unknown>[] = [], overrides: Record<string, unknown> = {}) => ({
    accountId: 'TEST', toDate: '20260916', AccountInformation: { currency: 'CZK' },
    EquitySummaryInBase: { EquitySummaryByReportDateInBase: { reportDate: '20260916', currency: 'CZK', total: '1000', cash: '560' } },
    OpenPositions: { OpenPosition: positions }, ...overrides,
});
const parse = (stmt: unknown) => parseAccountReport({ FlexStatements: { FlexStatement: stmt } });
const positions = (data: AccountData) => data.filter((i): i is PositionItem => i.tag === 'Position');

test('reads the real base currency from Account Information and preserves signed foreign positions', () => {
    const d = parse(statement([position({ position: '-2', positionValue: '-20', costBasisMoney: '-16', fifoPnlUnrealized: '-4' })]));
    assert.equal(accountMetric(d, 'BaseCurrency'), 'CZK');
    assert.equal(accountMetric(d, 'CashBalance'), 560);
    assert.equal(accountMetric(d, 'AvailableFunds'), undefined);
    assert.equal(positions(d)[0].value.marketValue, -20);
    assert.equal(positions(d)[0].value.fxRateToBase, 22);
    assert.equal(positions(d)[0].value.fifoPnlUnrealized, -4);
});

test('SUMMARY plus LOT does not double count; LOT-only reports aggregate without dropping positions', () => {
    const lot = position({ levelOfDetail: 'LOT', position: '1', positionValue: '10', costBasisMoney: '8', fifoPnlUnrealized: '2' });
    assert.equal(positions(parse(statement([position(), lot, lot])))[0].value.quantity, 2);
    const lots = positions(parse(statement([lot, { ...lot, costBasisPrice: '6', costBasisMoney: '6', fifoPnlUnrealized: '4' }])));
    assert.equal(lots.length, 1);
    assert.equal(lots[0].value.quantity, 2);
    assert.equal(lots[0].value.marketValue, 20);
    assert.equal(lots[0].value.costPrice, 7);
    assert.equal(lots[0].value.fifoPnlUnrealized, 6);
});

test('preserves zero cost/P&L and derives P&L only from actual cost-basis money', () => {
    const p = positions(parse(statement([position({ costBasisPrice: '0', costPrice: '8', fifoPnlUnrealized: '0', unrealizedPnL: '9' })])))[0].value;
    assert.equal(p.costPrice, 0);
    assert.equal(p.fifoPnlUnrealized, 0);
    const fallback = positions(parse(statement([position({ fifoPnlUnrealized: '', unrealizedPnL: '' })])))[0].value;
    assert.equal(fallback.fifoPnlUnrealized, 4);
    const missing = positions(parse(statement([position({ fifoPnlUnrealized: '', costBasisMoney: '' })])))[0].value;
    assert.equal(missing.fifoPnlUnrealized, undefined);
});

test('missing NAV, base, FX and derivative multipliers fail instead of silently assuming zero or one', () => {
    assert.throws(() => parse(statement([], { EquitySummaryInBase: undefined })), /NAV/);
    assert.throws(() => parse(statement([], { AccountInformation: undefined })), /měna/);
    assert.throws(() => parse(statement([position({ fxRateToBase: '' })])), /FX/);
    assert.throws(() => parse(statement([position({ assetCategory: 'OPT', multiplier: '', putCall: 'P', strike: '10' })])), /Multiplier/);
});

test('selects the latest dated NAV and rejects positions that do not reconcile to its stock total', () => {
    const d = parse(statement([position()], { EquitySummaryInBase: { EquitySummaryByReportDateInBase: [
        { currency: 'CZK', reportDate: '20260101', total: '300', cash: '100' },
        { currency: 'CZK', reportDate: '20260916', total: '1000', cash: '560', stock: '440' },
    ] } }));
    assert.equal(accountMetric(d, 'NetLiquidation'), 1000);
    assert.equal(accountMetric(d, 'ReportDate'), '16.09.2026');
    assert.throws(() => parse(statement([position({ reportDate: '20260915' })], {
        EquitySummaryInBase: { EquitySummaryByReportDateInBase: { currency: 'CZK', reportDate: '20260916', total: '1000', cash: '560', stock: '440' } },
    })), /nesouhlasí/);
});

test('merges accounts only in the same base currency and rejects overlapping account IDs', () => {
    const d = parse(statement());
    const other = parse(statement([], { accountId: 'OTHER' }));
    assert.equal(accountMetric(mergeAccountDatas([{ data: d, name: 'A' }, { data: other, name: 'B' }]), 'NetLiquidation'), 2000);
    assert.throws(() => mergeAccountDatas([{ data: d, name: 'A' }, { data: d, name: 'Duplicate' }]), /Stejný IBKR/);
    const usd = other.map(item => item.tag === 'BaseCurrency' ? { ...item, value: 'USD' } : item);
    assert.throws(() => mergeAccountDatas([{ data: d, name: 'A' }, { data: usd, name: 'USD' }]), /různé základní/);
});

test('handles real XML string attributes without corrupting account or conid identity', () => {
    const xml = '<FlexQueryResponse><FlexStatements><FlexStatement accountId="000123" toDate="20260916"><AccountInformation currency="EUR"/><EquitySummaryInBase><EquitySummaryByReportDateInBase reportDate="20260916" cash="-10" total="-10" currency="EUR"/></EquitySummaryInBase><OpenPositions/></FlexStatement></FlexStatements></FlexQueryResponse>';
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false }).parse(xml);
    const d = parseAccountReport(parsed.FlexQueryResponse);
    assert.equal(accountMetric(d, 'AccountIds'), '["000123"]');
    assert.equal(accountMetric(d, 'CashBalance'), -10);
});

const put = (quantity: number, strike: number, overrides: Partial<PositionItem['value']> = {}, currency = 'USD'): PositionItem => ({
    tag: 'Position', currency,
    value: { symbol: `XYZ 260918P${strike}`, accountId: 'TEST', underlying: 'XYZ', multiplier: 100, expiry: '18.09.2026',
        assetClass: 'OPT', type: 'PUT', quantity, strike, marketValue: quantity * 100, markPrice: 1, fxRateToBase: 22, ...overrides },
});

test('lower-strike protection limits a credit spread to strike width and does not mutate inputs', () => {
    const input = [put(-2, 100), put(1, 90)];
    const output = annotatePutCommitments(input);
    assert.equal(output[0].value.commitedCapital, 20000);
    assert.equal(output[0].value.netCommitedCapital, 11000);
    assert.equal(output[0].value.hedgedQty, 1);
    assert.equal(input[0].value.netCommitedCapital, undefined);
});

test('higher-strike protection may reduce exercise obligation to zero; a long contract is consumed once', () => {
    const output = annotatePutCommitments([put(-1, 100), put(-1, 90), put(1, 110)]);
    assert.equal(output[0].value.netCommitedCapital, 0);
    assert.equal(output[1].value.netCommitedCapital, 9000);
});

test('never nets a hedge across accounts, expiries, currencies, multipliers or trading classes', () => {
    for (const mismatch of [{ accountId: 'OTHER' }, { expiry: '25.09.2026' }, { multiplier: 10 }, { tradingClass: 'XYZ1' }]) {
        const out = annotatePutCommitments([put(-1, 100), put(1, 110, mismatch)]);
        assert.equal(out[0].value.netCommitedCapital, 10000);
    }
    assert.equal(annotatePutCommitments([put(-1, 100), put(1, 110, {}, 'EUR')])[0].value.netCommitedCapital, 10000);
});
