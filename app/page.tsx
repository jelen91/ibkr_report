'use client';

import { useState, useEffect, useRef } from 'react';
import CapitalAllocationChart from './components/CapitalAllocationChart';
import UtilizationBar from './components/UtilizationBar';
import ExposureSummary from './components/ExposureSummary';
import { computeExposure, type ExposureCategory } from './lib/exposure';
import PositionTable from './components/PositionTable';
import CredentialsForm from './components/CredentialsForm';
import Instructions from './components/Instructions';
import { AccountData, PositionItem, Account } from './types';
import { mergeAccountDatas, annotatePutCommitments } from './lib/account';

// ─── helpers ──────────────────────────────────────────────────────────────────

const LS_ACCOUNTS = 'ibkr_accounts';
const LS_EXPOSURE_CATEGORIES = 'ibkr_exposure_categories';

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
  const [exposureCategories, setExposureCategories] = useState<Record<string, ExposureCategory>>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | 'all'>('all');
  const [dataCache, setDataCache] = useState<Record<string, AccountData>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const pending = useRef(new Set<string>());

  // ── init from localStorage ──
  useEffect(() => {
    try {
      const savedCategories = JSON.parse(localStorage.getItem(LS_EXPOSURE_CATEGORIES) || '{}');
      if (savedCategories && typeof savedCategories === 'object' && !Array.isArray(savedCategories)) {
        setExposureCategories(Object.fromEntries(Object.entries(savedCategories).filter(([, value]) => ['equities', 'commodities', 'crypto'].includes(String(value)))) as Record<string, ExposureCategory>);
      }
    } catch { /* default categories */ }
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

  function updateExposureCategory(key: string, category: ExposureCategory) {
    setExposureCategories(previous => {
      const next = { ...previous, [key]: category };
      try { localStorage.setItem(LS_EXPOSURE_CATEGORIES, JSON.stringify(next)); } catch { /* unavailable browser storage */ }
      return next;
    });
  }

  // ── fetch one account ──
  async function fetchAccount(acct: Account) {
    if (pending.current.has(acct.id)) return;
    pending.current.add(acct.id);
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
      pending.current.delete(acct.id);
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
  const loadedPairs = accounts
    .map(a => dataCache[a.id] ? { data: dataCache[a.id], name: a.name } : null)
    .filter(Boolean) as { data: AccountData; name: string }[];

  let mergeError: string | undefined;
  let activeData: AccountData | null = null;
  try {
    if (activeId === 'all') {
      // A partial set of accounts must never be presented as the complete total.
      activeData = loadedPairs.length === accounts.length && accounts.length > 0
        ? mergeAccountDatas(loadedPairs) : null;
    } else activeData = dataCache[activeId] ?? null;
  } catch (error) {
    mergeError = error instanceof Error ? error.message : 'Účty nelze sloučit.';
  }

  const showAccountCol = activeId === 'all' && accounts.length > 1;

  const isLoading = activeId === 'all'
    ? loadingIds.size > 0
    : loadingIds.has(activeId);

  const activeError = mergeError ?? (activeId === 'all'
    ? Object.values(errors)[0]
    : errors[activeId]);

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
  const positions = annotatePutCommitments(activeData?.filter(isPosition) || []);
  const stocks = positions.filter(p => p.value.assetClass === 'STK');
  const cryptos = positions.filter(p => p.value.assetClass === 'CRYPTO');
  const futures = positions.filter(p => p.value.assetClass === 'FUT');
  const options = positions.filter(p => p.value.assetClass === 'OPT');
  const otherPositions = positions.filter(p => !['STK', 'CRYPTO', 'FUT', 'OPT'].includes(p.value.assetClass));

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
  const cashBalance = Number(getMetricValue('CashBalance'));
  const dataWarning = String(getMetricValue('DataWarning') || '');
  const acctBaseCurrency = String(getMetricValue('BaseCurrency') || 'CZK');
  const formatDisplay = (v: number) =>
    v.toLocaleString('cs-CZ', { maximumFractionDigits: 2 }) + '\u00a0' + acctBaseCurrency;

  const sumInBase = (items: PositionItem[]) => items.reduce((sum, p) => sum + p.value.marketValue * (p.value.fxRateToBase ?? 1), 0);
  const stockValue = sumInBase(stocks);
  const cryptoValue = sumInBase(cryptos);
  const optionValue = sumInBase(options);
  // Futures notionals are exposures, not amounts paid or components of NAV.
  const otherValue = netLiquidation - cashBalance - stockValue - cryptoValue - optionValue;
  const exposure = computeExposure(positions, netLiquidation, exposureCategories);
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
          {(activeError || dataWarning) && <div className="content-container"><p role="status">{activeError ? 'Zobrazená data jsou z posledního úspěšného stažení. ' : ''}{dataWarning}</p></div>}
          <div className="responsive-grid">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', justifyContent: 'space-between' }}>
              <div className="card summary-card">
                <h3>AUM / čistá hodnota účtu</h3>
                <div className="value">{formatDisplay(netLiquidation)}</div>
                <div className="subtext">Celková hodnota účtu</div>
              </div>
              <div className="card summary-card">
                <h3>Hotovost ve výpisu</h3>
                <div className="value">{formatDisplay(cashBalance)}</div>
                <div className="subtext">Zůstatek hotovosti včetně případného úvěru</div>
              </div>
              <div className="card summary-card">
                <h3>Vázaný kapitál</h3>
                <div className="value">{exposure.percentage === null ? '—' : formatDisplay(exposure.total)}</div>
                <div className="subtext">Držené akcie, ETF a krypto {formatDisplay(exposure.investedHoldings)} + závazek PUT {formatDisplay(exposure.putCommitments)}.</div>
              </div>
              <UtilizationBar invested={exposure.total} total={netLiquidation} complete={exposure.percentage !== null} />
            </div>

            <CapitalAllocationChart
              stockValue={stockValue}
              cryptoValue={cryptoValue}
              optionValue={optionValue}
              otherValue={otherValue}
              cashBalance={cashBalance}
              total={netLiquidation}
              acctBaseCurrency={acctBaseCurrency}
            />
          </div>

          <div className="content-container">
            <ExposureSummary exposure={exposure} nav={netLiquidation} currency={acctBaseCurrency} onCategoryChange={updateExposureCategory} />
            <p className="subtext">Hodnoty pocházejí z denního Flex výpisu, nejde o živé kotace. Záporné hodnoty představují závazky.</p>

            <PositionTable title="Short Puts (Příjem)"
              data={options.filter(o => o.value.type === 'PUT' && o.value.quantity < 0)}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Blokováno $', 'Blokováno CZK', '%']}
              color="#e74c3c" {...tableProps} />

            <PositionTable title="Short Calls (Příjem)"
              data={options.filter(o => o.value.type === 'CALL' && o.value.quantity < 0)}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--danger-color)" {...tableProps} />

            <PositionTable title="Long Puts (Zajištění)"
              data={options.filter(o => o.value.type === 'PUT' && o.value.quantity > 0)}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--option-color)" {...tableProps} />

            <PositionTable title="Long Calls (Růst)"
              data={options.filter(o => o.value.type === 'CALL' && o.value.quantity > 0)}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--option-color)" {...tableProps} />

            <PositionTable title="Akcie"
              data={stocks}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--primary-color)" {...tableProps} />

            <PositionTable title="Krypto"
              data={cryptos}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Asset', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--primary-color)" {...tableProps} />

            <PositionTable title="Futures (nominální expozice)"
              data={futures}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Expirace', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--futures-color)" {...tableProps} />
            <PositionTable title="Ostatní instrumenty"
              data={otherPositions}
              columns={[...(showAccountCol ? ['Účet'] : []), 'Ticker', 'Asset', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
              color="var(--primary-color)" {...tableProps} />

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
