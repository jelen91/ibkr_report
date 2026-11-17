import test from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingCloses, lastIntradayCloses, netTotalReturn, parseDailyChart, ymdToEpoch } from '../app/lib/benchmarkData';

// Yahoo stamps LSE daily bars at the 08:00 UTC session open.
const at = (ymd: string, hour = 8) => ymdToEpoch(ymd) + hour * 3600;
const daily = (rows: [string, number | null, number | null][], extra: Record<string, unknown> = {}) => ({
    meta: { currency: 'USD' },
    timestamp: rows.map(([date]) => at(date)),
    indicators: { quote: [{ close: rows.map(([, close]) => close) }], adjclose: [{ adjclose: rows.map(([, , adj]) => adj) }] },
    ...extra,
});
const hourly = (rows: [string, number, number | null][]) => ({
    timestamp: rows.map(([date, hour]) => at(date, hour)),
    indicators: { quote: [{ close: rows.map(([, , close]) => close) }] },
});

test('a trading day with an empty daily bar is reported as missing instead of silently reusing an older price', () => {
    const parsed = parseDailyChart(daily([['20261112', 824, 824], ['20261113', 813.41, 813.41], ['20261116', null, null]]), '20261116');
    assert.deepEqual(parsed.prices, { '20261112': 824, '20261113': 813.41 });
    assert.deepEqual(parsed.missing, ['20261116']);
});

test('the bar of a session that is still open is neither a close nor a missing day', () => {
    const chart = daily([['20261113', 813.41, 813.41], ['20261117', 799, 799]], {
        meta: { currency: 'USD', currentTradingPeriod: { regular: { start: at('20261117'), end: at('20261117', 16) } } },
    });
    const parsed = parseDailyChart(chart, '20261117', at('20261117', 10));
    assert.deepEqual(parsed.prices, { '20261113': 813.41 });
    assert.deepEqual(parsed.missing, []);
});

test('a missing close is filled with the last hourly price of the same day', () => {
    const parsed = parseDailyChart(daily([['20261113', 813.41, 813.41], ['20261116', null, null]]), '20261116');
    const intraday = lastIntradayCloses(hourly([['20261116', 8, 805], ['20261116', 16, 808.69], ['20261116', 15, null], ['20261117', 8, 799]]));
    assert.deepEqual(fillMissingCloses(parsed, intraday), ['20261116']);
    assert.equal(parsed.prices['20261116'], 808.69);
    assert.equal(parsed.closes['20261116'], 808.69);
    assert.equal(parsed.prices['20261117'], undefined);
});

test('a filled day keeps the dividend adjustment of the previous complete day', () => {
    const parsed = parseDailyChart(daily([['20260105', 100, 98], ['20260106', null, null]]), '20260106');
    fillMissingCloses(parsed, { '20260106': 110 });
    assert.ok(Math.abs(parsed.closes['20260106'] - 107.8) < 1e-9);
});

test('a missing day without any hourly trade, such as a holiday, stays unfilled', () => {
    const parsed = parseDailyChart(daily([['20251224', 700, 700], ['20251225', null, null]]), '20251225');
    assert.deepEqual(fillMissingCloses(parsed, {}), []);
    assert.equal(parsed.prices['20251225'], undefined);
});

test('net total return reinvests a dividend after withholding, also when its ex-date has no close', () => {
    const prices = { '20260102': 100, '20260105': 98, '20260107': 99 };
    const onExDate = netTotalReturn(prices, { '20260105': 2 }, 0.15);
    // 100 → 98 + 1.7 → ×99/98; normalized to the last close.
    const growth = (98 + 1.7) / 100 * 99 / 98;
    assert.ok(Math.abs(onExDate['20260107'] - 99) < 1e-9);
    assert.ok(Math.abs(onExDate['20260107'] / onExDate['20260102'] - growth) < 1e-12);
    const gap = netTotalReturn(prices, { '20260106': 2 }, 0.15);
    assert.ok(Math.abs(gap['20260107'] / gap['20260102'] - (98 / 100) * (99 + 1.7) / 98) < 1e-12);
    assert.deepEqual(netTotalReturn(prices, {}, 0.15), prices);
});
