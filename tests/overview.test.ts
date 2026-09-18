import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOverview, czkRate, valueAt, type QuotesPayload, type OverviewSeries } from '../app/lib/overview';
const account = { id: 'one', name: 'Test', token: 'unused', queryId: 'unused' };
const quotes: QuotesPayload = { quotes: {}, btc: null, failed: [], fx: { USD: { symbol: 'USDCZK=X', name: 'USD', currency: 'CZK', price: 23, history: { '20260101': 22, '20260102': 24 } } } };
const series: OverviewSeries = { currency: 'USD', accountIds: ['A'], nav: [{ date: '20260101', nav: 100 }, { date: '20260102', nav: 110 }], flows: [] };
const input = { accounts: [account], series: { one: series }, holdings: [], manual: [], btcAmount: 0, quotes, today: '20260103' };
test('converts foreign IBKR NAV with report-date FX, not current FX or 1:1', () => {
 const v = buildOverview(input); assert.equal(v.total,2640); assert.equal(v.chart[0].total,2200);
});
test('unknown FX blocks total instead of making an asset disappear', () => {
 const v=buildOverview({...input, quotes:null}); assert.equal(v.total,null); assert.deepEqual(v.missing,['IBKR']); assert.equal(v.chart.length,0);
});
test('duplicated IBKR report accounts cannot double total', () => {
 const v=buildOverview({...input, accounts:[account,{...account,id:'two'}],series:{one:series,two:series}}); assert.equal(v.total,null); assert.equal(v.ibkrRows[1].overlap,true);
});
test('short holdings and manual liabilities retain their signs', () => {
 const v=buildOverview({...input, accounts:[], series:{}, holdings:[{id:'s',symbol:'SHORT',quantity:-2,note:''}], manual:[{id:'m',name:'Debt',amount:-50,currency:'CZK'}],quotes:{...quotes,quotes:{SHORT:{symbol:'SHORT',name:'Short',currency:'USD',price:10,history:{'20260101':10}}}}}); assert.equal(v.total,-510); assert.equal(v.parts.length,2);
});
test('missing historical FX never takes a future/current rate', () => {
 assert.equal(czkRate(quotes,'USD','20251231'),null); assert.equal(valueAt({'20260102':10},'20260101'),null);
});
test('history starts only when all included accounts have observations', () => {
 const v=buildOverview({...input, accounts:[account,{...account,id:'two'}],series:{one:series,two:{...series,accountIds:['B'],nav:[{date:'20260102',nav:10}]}}}); assert.deepEqual(v.chart.map(p=>p.date),['20260102']); assert.equal(v.total,2880);
});
test('zero quantity does not require a quote; nonzero BTC does', () => {
 assert.equal(buildOverview({...input,accounts:[],series:{},quotes:null}).total,0);
 assert.equal(buildOverview({...input,accounts:[],series:{},quotes:null,btcAmount:1}).total,null);
});
