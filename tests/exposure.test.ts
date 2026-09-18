import assert from 'node:assert/strict';
import test from 'node:test';
import { computeExposure } from '../app/lib/exposure';
import type { PositionItem } from '../app/types';

const stock = (symbol: string, marketValue: number, quantity = 100, overrides: Partial<PositionItem['value']> = {}, currency = 'USD'): PositionItem => ({
    tag: 'Position', currency,
    value: { symbol, quantity, marketValue, markPrice: marketValue / quantity, multiplier: 1,
        assetClass: 'STK', accountId: 'TEST', fxRateToBase: 1, ...overrides },
});
const option = (symbol: string, type: 'PUT' | 'CALL', quantity: number, strike: number,
    marketValue = quantity * 100, overrides: Partial<PositionItem['value']> = {}, currency = 'USD'): PositionItem => ({
    tag: 'Position', currency,
    value: { symbol: `${symbol} 260918${type[0]}${strike}`, underlying: symbol, type, quantity, strike, marketValue,
        markPrice: Math.abs(marketValue / quantity / 100), multiplier: 100, assetClass: 'OPT', accountId: 'TEST',
        fxRateToBase: 1, expiry: '18.09.2026', ...overrides },
});
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

test('reproduces the reference spreadsheet: holdings and put commitments, without purchased options or duplicate covered calls', () => {
    const held: [string, number, number][] = [
        ['AMZN', 77034, 300], ['IAU', 57197, 700], ['WEAT', 39375, 1500], ['HOOD', 45028, 400],
        ['TTD', 28680, 2000], ['ETHA', 26824, 1400], ['NFLX', 54180, 700], ['RHM', 69464, 60],
        ['TMO', 67080, 110], ['MRNA', 50390, 350], ['TNZ', 53124, 1000], ['IBIT', 43770, 1000],
        ['FETH', 37935, 1500], ['PURR', 23220, 2000], ['LIDO', 3500, 3500],
    ];
    const input = [
        ...held.map(([symbol, amount, quantity]) => stock(symbol, amount, quantity)),
        option('WEAT', 'PUT', -15, 26), option('SLV', 'PUT', -7, 62), option('GDX', 'PUT', -5, 90),
        option('MRNA', 'PUT', -8, 45), option('XBI', 'PUT', -3, 162),
        option('HOOD', 'CALL', -4, 100), option('TTD', 'CALL', -20, 14),
        option('ETHA', 'CALL', -14, 15), option('NFLX', 'CALL', -7, 79),
        option('XLU', 'CALL', 24, 80, 3000), option('CANE', 'CALL', 40, 10, 2500),
        option('SPY', 'PUT', 30, 700, 45000), option('QQQ', 'PUT', 80, 500, 20000),
        option('SPCX', 'PUT', 24, 75, 2500),
    ];
    const before = structuredClone(input);
    const result = computeExposure(input, 2051419);
    assert.equal(result.total, 888801);
    assert.equal(result.investedHoldings, 676801);
    assert.equal(result.putCommitments, 212000);
    assert.equal(Math.round(result.percentage!), 43);
    assert.equal(result.longCalls, 5500);
    // Purchased protective puts are shown at their gross market value separately.
    assert.equal(result.longPuts, 67500);
    assert.deepEqual(result.unsupported, []);
    assert.equal(result.rows.find(row => row.symbol === 'WEAT')?.total, 78375);
    assert.equal(result.rows.find(row => row.symbol === 'ETHA')?.category, 'equities');
    assert.equal(result.categories.commodities, 223972);
    assert.equal(result.categories.crypto, 108425);
    assert.equal(Math.round(result.categories.equities / 2051419 * 100), 27);
    assert.deepEqual(input, before);
});

test('current reported holdings plus puts produce 62.6159%, whereas puts alone are only 14.3914%', () => {
    const result = computeExposure([
        stock('HOLDINGS', 1585375.87744),
        option('PUTS', 'PUT', -1, 4731.168),
    ], 3287490.346014089);
    near(result.total, 2058492.67744);
    near(result.percentage!, 62.61593071857428);
    assert.equal(result.percentage!.toFixed(1), '62.6');
});

test('converts holdings, option values and strike commitments with the actual instrument FX', () => {
    const result = computeExposure([
        stock('XYZ', 500, 100, { fxRateToBase: 22 }),
        option('XYZ', 'PUT', -2, 10, -200, { fxRateToBase: 22 }),
        option('XYZ', 'PUT', 1, 8, 50, { fxRateToBase: 22 }),
        option('XYZ', 'CALL', 1, 12, 25, { fxRateToBase: 22 }),
    ], 100000);
    assert.equal(result.investedHoldings, 11000);
    assert.equal(result.putCommitments, 26400);
    assert.equal(result.longCalls, 550);
    assert.equal(result.longPuts, 1100);
    near(result.percentage!, 37.4);
});

test('put protection cannot offset other accounts, models, currencies or expiries', () => {
    for (const mismatch of [{ accountId: 'OTHER' }, { model: 'OTHER' }, { expiry: '25.09.2026' }]) {
        const result = computeExposure([option('XYZ', 'PUT', -1, 100), option('XYZ', 'PUT', 1, 110, 50, mismatch)], 20000);
        assert.equal(result.putCommitments, 10000);
    }
    const otherCurrency = computeExposure([
        option('XYZ', 'PUT', -1, 100), option('XYZ', 'PUT', 1, 110, 50, {}, 'EUR'),
    ], 20000);
    assert.equal(otherCurrency.putCommitments, 10000);
});

test('short calls consume held shares only once across contracts and do not cross account boundaries', () => {
    const holdings = stock('XYZ', 10000, 100);
    const call = option('XYZ', 'CALL', -1, 100);
    assert.equal(computeExposure([holdings, call], 20000).percentage, 50);
    const twice = computeExposure([holdings, call, option('XYZ', 'CALL', -1, 110)], 20000);
    assert.equal(twice.total, 10000);
    assert.equal(twice.percentage, null);
    assert.match(twice.unsupported.join(' '), /call.*krytá/);
    for (const mismatch of [{ accountId: 'OTHER' }, { model: 'OTHER' }, { conid: '2' }]) {
        const result = computeExposure([
            stock('XYZ', 10000, 100, { conid: '1', ...mismatch }),
            option('XYZ', 'CALL', -1, 100, -100, { underlyingConid: '1' }),
        ], 20000);
        assert.equal(result.percentage, null);
    }
    assert.equal(computeExposure([holdings, option('XYZ', 'CALL', -1, 100, -100, {}, 'EUR')], 20000).percentage, null);
});

test('covered calls match underlying identifiers and use the supplied contract multiplier', () => {
    const result = computeExposure([
        stock('XYZ.A', 1000, 50, { conid: '123' }),
        option('XYZ', 'CALL', -5, 10, -100, { multiplier: 10, underlyingConid: '123' }),
    ], 2000);
    assert.equal(result.percentage, 50);
    assert.deepEqual(result.unsupported, []);
});

test('category overrides normalize symbols and apply to both holdings and puts without changing total exposure', () => {
    const input = [stock('IGLN', 100), stock('IBIT', 200), stock('BTC', 300, 1, { assetClass: 'CRYPTO' }),
        stock('ETHA', 400), option('ETHA', 'PUT', -1, 10)];
    const defaults = computeExposure(input, 10000);
    const overridden = computeExposure(input, 10000, { ' etha ': 'crypto', ibit: 'equities' });
    assert.deepEqual(defaults.categories, { equities: 1400, commodities: 100, crypto: 500 });
    assert.deepEqual(overridden.categories, { equities: 200, commodities: 100, crypto: 1700 });
    assert.equal(overridden.total, defaults.total);
    assert.equal(overridden.rows.find(row => row.key === 'ETHA')?.total, 1400);
});

test('unsupported positions and missing numerical fields cannot yield a misleading complete percentage', () => {
    const unsupported = [
        stock('SHORT', -100, -1), stock('FUT', 100, 1, { assetClass: 'FUT' }),
        stock('FX', 100, 1, { fxRateToBase: undefined }), stock('BADFX', 100, 1, { fxRateToBase: 0 }),
        stock('BADVALUE', Number.NaN), option('UNKNOWN', 'PUT', -1, 10, -100, { multiplier: undefined }),
        option('UNKNOWN', 'PUT', -1, 10, -100, { strike: undefined }),
        option('UNKNOWN', 'PUT', -1, 10, -100, { type: undefined }),
    ];
    for (const p of unsupported) {
        const result = computeExposure([stock('VALID', 50), p], 1000);
        assert.equal(result.percentage, null, p.value.symbol);
        assert.equal(result.total, 50);
        assert.equal(result.unsupported.length, 1);
    }
});

test('zero positions and cash add no exposure; invalid NAV is unavailable and leverage is not capped', () => {
    assert.equal(computeExposure([], 100).percentage, 0);
    const empty = computeExposure([stock('CASH', 1000, 1000, { assetClass: 'CASH' }),
        stock('EMPTY', 0, 0, { fxRateToBase: undefined })], 1000);
    assert.equal(empty.percentage, 0);
    for (const nav of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(computeExposure([stock('XYZ', 100)], nav).percentage, null);
    }
    assert.equal(computeExposure([stock('XYZ', 200)], 100).percentage, 200);
});
