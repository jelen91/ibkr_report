import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBtcQuote, parseYahooQuote } from '../app/lib/quotes';
const yahoo = (meta: Record<string, unknown>, closes: unknown[] = [100], timestamp = [1760000000]) => ({ chart: { result: [{
    meta: { currency: 'USD', regularMarketPrice: 101, regularMarketTime: 1760000100, ...meta },
    timestamp, indicators: { quote: [{ close: closes }] },
}] } });

test('converts pence to pounds for current and historical quotes and preserves provider time', () => {
    const q = parseYahooQuote('TEST.L', yahoo({ currency: 'GBp' }, [10000]));
    assert.equal(q?.currency, 'GBP');
    assert.equal(q?.price, 1.01);
    assert.equal(Object.values(q!.history)[0], 100);
    assert.equal(q?.asOf, 1760000100000);
});
test('missing/invalid prices never become zero or default USD currency', () => {
    assert.equal(parseYahooQuote('TEST', yahoo({ currency: undefined })), null);
    assert.equal(parseYahooQuote('TEST', yahoo({ regularMarketPrice: NaN }, [null])), null);
    assert.equal(parseYahooQuote('TEST', yahoo({ regularMarketPrice: 0 }, [0])), null);
});
test('a historical fallback carries the date of the actual last valid observation', () => {
    const q = parseYahooQuote('TEST', yahoo({ regularMarketPrice: null }, [90, null, 95], [1760000000, 1760000200, 1760000300]));
    assert.equal(q?.price, 95);
    assert.equal(q?.asOf, 1760000300000);
});
test('BTC ignores malformed observations, sorts dates and retains actual history coverage', () => {
    const q = parseBtcQuote({ prices: [[1760000300000, 300], [1760000000000, 200], [1760000400000, null], [0, 10]] });
    assert.equal(q?.price, 300);
    assert.equal(q?.asOf, 1760000300000);
    assert.equal(parseBtcQuote({ prices: [[1760000000000, -1]] }), null);
});

test('quotes endpoint fetches requested account-base FX and isolates a failed security', async () => {
    const { GET } = await import('../app/api/quotes/route');
    const { NextRequest } = await import('next/server');
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (url: any) => {
        const address = String(url);
        requested.push(address);
        if (address.includes('/BROKEN?')) throw new Error('provider unavailable');
        return new Response(JSON.stringify(yahoo({ currency: address.includes('CZK%3DX') ? 'CZK' : 'USD' })), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        const response = await GET(new NextRequest('http://localhost/api/quotes?symbols=GOOD,BROKEN&currencies=CHF&range=3mo'));
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.quotes.GOOD.price, 101);
        assert.equal(body.quotes.BROKEN, undefined);
        assert.ok(body.fx.CHF);
        assert.ok(requested.some(url => url.includes('CHFCZK%3DX')));
        assert.deepEqual(body.failed, ['BROKEN']);
    } finally { globalThis.fetch = originalFetch; }
});
