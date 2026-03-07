'use client';

import { useState, useEffect } from 'react';
import CapitalAllocationChart from './components/CapitalAllocationChart';
import UtilizationBar from './components/UtilizationBar';
import PositionTable from './components/PositionTable';
import CredentialsForm from './components/CredentialsForm';
import Instructions from './components/Instructions';
import { AccountData, PositionItem, Account } from './types';

// ─── helpers ──────────────────────────────────────────────────────────────────

function mergeAccountDatas(datasets: AccountData[]): AccountData {
  const result: AccountData = [];
  let netLiq = 0, cash = 0, stockLong = 0, optShort = 0;
  let reportDate: string | null = null;
  let baseCurrency = 'CZK';

  for (const data of datasets) {
    for (const item of data) {
      if (item.tag === 'Position') {
        result.push(item);
      } else if (item.tag === 'NetLiquidation') {
        netLiq += Number(item.value);
      } else if (item.tag === 'AvailableFunds') {
        cash += Number(item.value);
      } else if (item.tag === 'StockValueLong') {
        stockLong += Number(item.value);
      } else if (item.tag === 'OptionValueShort') {
        optShort += Number(item.value);
      } else if (item.tag === 'ReportDate' && !reportDate) {
        reportDate = String(item.value);
        result.push(item);
      } else if (item.tag === 'BaseCurrency' && !result.find(r => r.tag === 'BaseCurrency')) {
        baseCurrency = String(item.value);
        result.push(item);
      } else if (item.tag === 'EurToCzkRate' && !result.find(r => r.tag === 'EurToCzkRate')) {
        result.push(item);
      }
    }
  }

  result.unshift(
    { tag: 'NetLiquidation', value: netLiq, currency: baseCurrency },
    { tag: 'AvailableFunds', value: cash, currency: baseCurrency },
    { tag: 'StockValueLong', value: stockLong, currency: baseCurrency },
    { tag: 'OptionValueShort', value: optShort, currency: baseCurrency },
  );

  return result;
}

const LS_ACCOUNTS = 'ibkr_accounts';

function loadAccounts(): Account[] {
  try {
    const raw = localStorage.getItem(LS_ACCOUNTS);
    if (raw) return JSON.parse(raw);
  } catch { }
  return [];
}

function saveAccounts(accounts: Account[]) {
  localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts));
}

// ─── component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | 'all'>('all');
  const [dataCache, setDataCache] = useState<Record<string, AccountData>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAddForm, setShowAddForm] = useState(false);

  // ── init from localStorage ──
  useEffect(() => {
    const saved = loadAccounts();
    if (saved.length > 0) {
      setAccounts(saved);
      setActiveId(saved.length === 1 ? saved[0].id : 'all');
      saved.forEach(fetchAccount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── auto-refresh every 60 s ──
  useEffect(() => {
    if (accounts.length === 0) return;
    const interval = setInterval(() => accounts.forEach(fetchAccount), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  // ── fetch one account ──
  async function fetchAccount(acct: Account) {
    setLoadingIds(prev => new Set(prev).add(acct.id));
    setErrors(prev => { const e = { ...prev }; delete e[acct.id]; return e; });
    try {
      const res = await fetch('/api/account', {
        headers: { 'x-flex-token': acct.token, 'x-flex-query-id': acct.queryId },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Chyba načítání');
      }
      const data: AccountData = await res.json();
      setDataCache(prev => ({ ...prev, [acct.id]: data }));
    } catch (e: any) {
      setErrors(prev => ({ ...prev, [acct.id]: e.message }));
    } finally {
      setLoadingIds(prev => { const s = new Set(prev); s.delete(acct.id); return s; });
    }
  }

  // ── add account ──
  function handleAddAccount(name: string, token: string, queryId: string) {
    const acct: Account = { id: crypto.randomUUID(), name, token, queryId };
    const updated = [...accounts, acct];
    setAccounts(updated);
    saveAccounts(updated);
    setShowAddForm(false);
    setActiveId(acct.id);
    fetchAccount(acct);
  }

  // ── remove account ──
  function handleRemoveAccount(id: string) {
    const updated = accounts.filter(a => a.id !== id);
    setAccounts(updated);
    saveAccounts(updated);
    setDataCache(prev => { const d = { ...prev }; delete d[id]; return d; });
    setActiveId(updated.length === 0 ? 'all' : updated.length === 1 ? updated[0].id : 'all');
  }

  // ── active data ──
  const loadedData = accounts.map(a => dataCache[a.id]).filter(Boolean) as AccountData[];
  const activeData: AccountData | null = (() => {
    if (accounts.length === 0) return null;
    if (activeId === 'all') {
      return loadedData.length > 0 ? mergeAccountDatas(loadedData) : null;
    }
    return dataCache[activeId] ?? null;
  })();

  const isLoading = activeId === 'all'
    ? loadingIds.size > 0
    : loadingIds.has(activeId);

  const activeError = activeId === 'all'
    ? Object.values(errors)[0]
    : errors[activeId];

  // ── derived metrics ──
  const getMetricValue = (tag: string): string | number => {
    if (!activeData) return 0;
    const item = activeData.find(p => p.tag === tag);
    if (!item || typeof item.value === 'object') return 0;
    return item.value;
  };

  const getReportDate = (): string | undefined => {
    if (!activeData) return undefined;
    const item = activeData.find(p => p.tag === 'ReportDate');
    if (item && typeof item.value === 'string') return item.value;
    return undefined;
  };

  const isPosition = (p: any): p is PositionItem => p.tag === 'Position';
  const positions = activeData?.filter(isPosition) || [];
  const stocks = positions.filter(p => p.value.assetClass === 'STK');
  const cryptos = positions.filter(p => p.value.assetClass === 'CRYPTO');
  const futures = positions.filter(p => p.value.assetClass === 'FUT');
  const options = positions.filter(p => p.value.assetClass === 'OPT');

  options.sort((a, b) => {
    const parseDate = (expiry: string | number | undefined) => {
      if (!expiry) return 0;
      const s = String(expiry);
      if (!s.includes('.')) {
        if (s.length === 8) return new Date(`${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`).getTime();
        return 0;
      }
      return new Date(s.split('.').reverse().join('-')).getTime();
    };
    return parseDate(a.value.expiry) - parseDate(b.value.expiry);
  });

  const netLiquidation = Number(getMetricValue('NetLiquidation'));
  const availableFunds = Number(getMetricValue('AvailableFunds'));
  const acctBaseCurrency = String(getMetricValue('BaseCurrency') || 'CZK');
  const formatDisplay = (v: number) =>
    v.toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + '\u00a0' + acctBaseCurrency;

  const stockValueLong = stocks.reduce((s, i) => s + (i.value.marketValue || 0) * (i.value.fxRateToBase || 1), 0);
  const cryptoValue = cryptos.reduce((s, i) => s + (i.value.marketValue || 0) * (i.value.fxRateToBase || 1), 0);
  const futuresValue = futures.reduce((s, i) => s + (i.value.marketValue || 0) * (i.value.fxRateToBase || 1), 0);

  // ── spread-aware committed capital + per-position annotation ────────────────
  // For bear put spreads (short low strike + long high strike on same underlying),
  // the real capital at risk is only (shortStrike - longStrike) × mult × qty ≤ 0 → 0.
  const totalCommitedCapital = (() => {
    const shortPuts = options.filter(o => o.value.type === 'PUT' && o.value.quantity < 0);
    const longPuts = options.filter(o => o.value.type === 'PUT' && o.value.quantity > 0);

    // Build a mutable long-put pool keyed by underlying (shared across all short puts)
    const longPool: Record<string, { strike: number; qty: number }[]> = {};
    for (const lp of longPuts) {
      const key = lp.value.underlying || lp.value.symbol;
      if (!longPool[key]) longPool[key] = [];
      longPool[key].push({ strike: lp.value.strike || 0, qty: lp.value.quantity });
      longPool[key].sort((a, b) => b.strike - a.strike); // best protection first
    }

    let total = 0;
    for (const sp of shortPuts) {
      const key = sp.value.underlying || sp.value.symbol;
      const shortQty = Math.abs(sp.value.quantity);
      const shortStrike = sp.value.strike || 0;
      const mult = sp.value.multiplier || 100;
      const fx = sp.value.fxRateToBase || 1;

      let remainingQty = shortQty;
      let commitmentBase = 0; // in base currency

      for (const lp of (longPool[key] ?? [])) {
        if (remainingQty <= 0) break;
        if (lp.strike <= shortStrike) continue;
        const covered = Math.min(remainingQty, lp.qty);
        commitmentBase += Math.max(0, shortStrike - lp.strike) * mult * covered * fx;
        lp.qty -= covered;
        remainingQty -= covered;
      }
      commitmentBase += shortStrike * mult * remainingQty * fx;

      // Annotate the position: net committed capital in native currency (per contract)
      // so PositionTable can compute %.  Raw = shortStrike × mult × |qty| (native).
      (sp.value as any).netCommitedCapital = commitmentBase / fx; // back to native
      (sp.value as any).hedgedQty = shortQty - remainingQty; // how many are hedged

      total += commitmentBase;
    }
    return total;
  })();

  const longOptionValue = options
    .filter(o => (o.value.type === 'CALL' || o.value.type === 'PUT') && o.value.quantity > 0)
    .reduce((s, i) => s + (i.value.marketValue || 0) * (i.value.fxRateToBase || 1), 0);
  const totalAllocated = stockValueLong + cryptoValue + futuresValue + Math.abs(totalCommitedCapital) + longOptionValue;
  const allocatedAlloc = netLiquidation ? (totalAllocated / netLiquidation * 100).toFixed(1) : '0';
  const derivedCash = Math.max(0, netLiquidation - totalAllocated);
  const reportDate = getReportDate();

  // ─── shared position table props ───
  const tableProps = { netLiquidation, acctBaseCurrency };

  return (
    <div className="app">
      <header className="dashboard-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', rowGap: '0.5rem' }}>

          {/* Left: title */}
          <h1 style={{ margin: 0 }}>IBKR Přehled Portfolia</h1>

          {/* Right: account tabs + date */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {reportDate && <div className="report-date">Data: {reportDate}</div>}

            {/* Account tabs */}
            {accounts.length > 0 && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {/* "Vše" tab — only when > 1 account */}
                {accounts.length > 1 && (
                  <button
                    onClick={() => setActiveId('all')}
                    style={tabStyle(activeId === 'all')}
                  >
                    Vše
                  </button>
                )}

                {accounts.map(acct => (
                  <div key={acct.id} style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      onClick={() => setActiveId(acct.id)}
                      style={tabStyle(activeId === acct.id)}
                    >
                      {loadingIds.has(acct.id) ? '⟳ ' : ''}{acct.name}
                    </button>
                    <button
                      onClick={() => handleRemoveAccount(acct.id)}
                      title="Odebrat účet"
                      style={{
                        fontSize: '0.7rem', padding: '2px 5px', marginLeft: '2px',
                        background: 'transparent', border: 'none', color: '#64748b',
                        cursor: 'pointer', borderRadius: '4px',
                      }}
                    >✕</button>
                  </div>
                ))}

                {/* Add account */}
                <button
                  onClick={() => setShowAddForm(f => !f)}
                  style={tabStyle(showAddForm)}
                  title="Přidat účet"
                >
                  +
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Inline add-account form */}
        {showAddForm && (
          <div style={{ width: '100%', marginTop: '0.75rem' }}>
            <CredentialsForm
              onConnect={handleAddAccount}
              loading={false}
              compact
            />
          </div>
        )}
      </header>

      {/* Empty state */}
      {accounts.length === 0 && !showAddForm && (
        <div className="grid">
          <CredentialsForm onConnect={handleAddAccount} loading={false} />
          <Instructions />
        </div>
      )}

      {/* Error */}
      {activeError && (
        <div className="content-container" style={{ marginTop: '1rem' }}>
          <div className="card" style={{ borderLeft: '4px solid var(--danger-color)' }}>
            <h3 style={{ color: 'var(--danger-color)', marginTop: 0 }}>Chyba – {accounts.find(a => a.id === activeId)?.name}</h3>
            <p>{activeError}</p>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && !activeData && (
        <div className="content-container" style={{ marginTop: '2rem', textAlign: 'center', opacity: 0.5 }}>
          Načítání dat…
        </div>
      )}

      {/* Dashboard */}
      {activeData && (
        <>
          <div className="responsive-grid">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', justifyContent: 'space-between' }}>
              <div className="card summary-card">
                <h3>Čistá Likvidace</h3>
                <div className="value">{formatDisplay(netLiquidation)}</div>
                <div className="subtext">Celková hodnota účtu</div>
              </div>
              <div className="card summary-card">
                <h3>Investovaný Kapitál</h3>
                <div className="value">{formatDisplay(totalAllocated)}</div>
                <div className="subtext">Aktiva + Blokované opce ({allocatedAlloc}%)</div>
              </div>
              <UtilizationBar invested={totalAllocated} total={netLiquidation} />
            </div>

            <CapitalAllocationChart
              stockValue={stockValueLong}
              cryptoValue={cryptoValue}
              futuresValue={futuresValue}
              optionBlocked={totalCommitedCapital}
              longOptionValue={longOptionValue}
              freeCash={derivedCash}
              total={netLiquidation}
              acctBaseCurrency={acctBaseCurrency}
            />
          </div>

          <div className="content-container">
            <div style={{ height: '3rem' }} />

            <PositionTable title="Short Puts (Příjem)"
              data={options.filter(o => o.value.type === 'PUT' && o.value.quantity < 0)}
              columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Blokováno $', 'Blokováno CZK', '%']}
              color="#e74c3c" {...tableProps} />

            <PositionTable title="Short Calls (Příjem)"
              data={options.filter(o => o.value.type === 'CALL' && o.value.quantity < 0)}
              columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--danger-color)" {...tableProps} />

            <PositionTable title="Long Puts (Zajištění)"
              data={options.filter(o => o.value.type === 'PUT' && o.value.quantity > 0)}
              columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--option-color)" {...tableProps} />

            <PositionTable title="Long Calls (Růst)"
              data={options.filter(o => o.value.type === 'CALL' && o.value.quantity > 0)}
              columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--option-color)" {...tableProps} />

            <PositionTable title="Akcie"
              data={stocks}
              columns={['Ticker', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--primary-color)" {...tableProps} />

            <PositionTable title="Krypto"
              data={cryptos}
              columns={['Ticker', 'Asset', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--primary-color)" {...tableProps} />

            <PositionTable title="Futures"
              data={futures}
              columns={['Ticker', 'Expirace', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Blokováno $', 'Blokováno CZK', '%']}
              color="var(--futures-color)" {...tableProps} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── tab button style ──────────────────────────────────────────────────────────
function tabStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: '0.78rem',
    fontWeight: active ? 700 : 500,
    padding: '4px 12px',
    borderRadius: '6px',
    border: active ? '1px solid #3b82f6' : '1px solid #334155',
    background: active ? '#1e40af' : '#1e293b',
    color: active ? '#fff' : '#94a3b8',
    cursor: 'pointer',
  };
}
