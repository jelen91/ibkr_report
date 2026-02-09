'use client';

import { useState, useEffect, Fragment } from 'react';
import CapitalAllocationChart from './components/CapitalAllocationChart';
import UtilizationBar from './components/UtilizationBar';
import PositionTable from './components/PositionTable';
import CredentialsForm from './components/CredentialsForm';
import Instructions from './components/Instructions';
import { AccountData, PositionItem } from './types';

export default function Dashboard() {
  const [accountData, setAccountData] = useState<AccountData | null>(null);
  const [status, setStatus] = useState({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // User Credentials State
  const [flexToken, setFlexToken] = useState<string>('');
  const [flexQueryId, setFlexQueryId] = useState<string>('');
  const [rememberMe, setRememberMe] = useState(false);

  // Initialize from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem('ibkr_flex_token');
    const savedQueryId = localStorage.getItem('ibkr_flex_query_id');

    if (savedToken && savedQueryId) {
      setFlexToken(savedToken);
      setFlexQueryId(savedQueryId);
      setRememberMe(true);
      // Auto-fetch with these credentials
      fetchStatus(savedToken, savedQueryId);
      fetchData(savedToken, savedQueryId);
    } else {
      // No credentials found, stay disconnected (show form)
      setStatus({ connected: false });
    }
  }, []);

  const fetchStatus = async (token?: string, queryId?: string) => {
    try {
      const headers: any = {};
      if (token) headers['x-flex-token'] = token;
      if (queryId) headers['x-flex-query-id'] = queryId;

      const res = await fetch('/api/status', { headers });
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      setStatus({ connected: false });
    }
  };

  const fetchData = async (token?: string, queryId?: string) => {
    try {
      setLoading(true);
      setError(null);

      const headers: any = {};
      // Use provided args or current state (if available)
      const t = token || flexToken;
      const q = queryId || flexQueryId;

      if (t) headers['x-flex-token'] = t;
      if (q) headers['x-flex-query-id'] = q;

      const res = await fetch('/api/account', { headers });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to fetch data');
      }

      const data = await res.json();
      setAccountData(data);

      // Update status to connected if successful
      setStatus({ connected: true });
    } catch (err: any) {
      setError(err.message);
      setStatus({ connected: false }); // Reset status on error
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = (token: string, queryId: string, remember: boolean) => {
    setFlexToken(token);
    setFlexQueryId(queryId);
    setRememberMe(remember);

    if (remember) {
      localStorage.setItem('ibkr_flex_token', token);
      localStorage.setItem('ibkr_flex_query_id', queryId);
    } else {
      localStorage.removeItem('ibkr_flex_token');
      localStorage.removeItem('ibkr_flex_query_id');
    }

    fetchData(token, queryId);
  };

  const handleDisconnect = () => {
    setFlexToken('');
    setFlexQueryId('');
    setAccountData(null);
    setStatus({ connected: false });
    localStorage.removeItem('ibkr_flex_token');
    localStorage.removeItem('ibkr_flex_query_id');
  };

  // Auto-refresh interval (only if connected)
  useEffect(() => {
    if (status.connected) {
      const interval = setInterval(() => fetchData(flexToken, flexQueryId), 60000);
      return () => clearInterval(interval);
    }
  }, [status.connected, flexToken, flexQueryId]);

  // Helper to get string/number metrics safely
  const getMetricValue = (tag: string): string | number => {
    if (!accountData) return 0;
    const item = accountData.find((p) => p.tag === tag);
    if (!item || typeof item.value === 'object') return 0;
    return item.value;
  };

  // Helper to get Report Date (string)
  const getReportDate = (): string | undefined => {
    if (!accountData) return undefined;
    const item = accountData.find(p => p.tag === 'ReportDate');
    if (item && typeof item.value === 'string') return item.value;
    return undefined;
  };

  // Filter positions by type with Type Guard
  const isPosition = (p: any): p is PositionItem => p.tag === 'Position';

  const positions = accountData?.filter(isPosition) || [];

  const stocks = positions.filter(p => p.value.assetClass === 'STK');
  const cryptos = positions.filter(p => p.value.assetClass === 'CRYPTO');
  const futures = positions.filter(p => p.value.assetClass === 'FUT');
  const options = positions.filter(p => p.value.assetClass === 'OPT');

  // Sort options by expiry
  options.sort((a, b) => {
    const parseDate = (expiry: string | number | undefined) => {
      if (!expiry) return 0;
      const s = String(expiry);
      // If YYYYMMDD (numeric or string without dots)
      if (!s.includes('.')) {
        if (s.length === 8) {
          return new Date(`${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`).getTime();
        }
        return 0;
      }
      // If DD.MM.YYYY
      return new Date(s.split('.').reverse().join('-')).getTime();
    };
    return parseDate(a.value.expiry) - parseDate(b.value.expiry);
  });

  const netLiquidation = Number(getMetricValue('NetLiquidation'));
  const availableFunds = Number(getMetricValue('AvailableFunds'));
  // Calculate Stock Value dynamically from positions (to support mock edits)
  const stockValueLong = stocks.reduce((sum, item) => sum + ((item.value.marketValue || 0) * (item.value.fxRateToBase || 1)), 0);
  const cryptoValue = cryptos.reduce((sum, item) => sum + ((item.value.marketValue || 0) * (item.value.fxRateToBase || 1)), 0);
  const futuresValue = futures.reduce((sum, item) => sum + ((item.value.marketValue || 0) * (item.value.fxRateToBase || 1)), 0);
  const optionValueShort = Number(getMetricValue('OptionValueShort'));

  // Calculate percentages
  const stockAlloc = netLiquidation ? (stockValueLong / netLiquidation * 100).toFixed(1) : '0';
  const optionAlloc = netLiquidation ? (Math.abs(optionValueShort) / netLiquidation * 100).toFixed(1) : '0';
  const cashAlloc = netLiquidation ? (availableFunds / netLiquidation * 100).toFixed(1) : '0';

  // Calculate totals for summary cards
  const totalCommitedCapital = options.reduce((sum, item) => sum + ((item.value.commitedCapital || 0) * (item.value.fxRateToBase || 1)), 0);

  // Calculate Long Option Value (Market Value converted to Base)
  // Include both CALLs and PUTs (Long)
  const longOptionValue = options
    .filter(o => (o.value.type === 'CALL' || o.value.type === 'PUT') && o.value.quantity > 0)
    .reduce((sum, item) => sum + ((item.value.marketValue || 0) * (item.value.fxRateToBase || 1)), 0);

  const totalAllocated = stockValueLong + cryptoValue + futuresValue + Math.abs(totalCommitedCapital) + longOptionValue;
  const allocatedAlloc = netLiquidation ? (totalAllocated / netLiquidation * 100).toFixed(1) : '0';

  // Derived Cash for Pie Chart (Net Liq - Invested)
  // If we are leveraged (>100%), cash slice is 0.
  const derivedCash = Math.max(0, netLiquidation - totalAllocated);

  const reportDate = getReportDate();

  return (
    <div className="app">
      <header className="dashboard-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h1>IBKR Přehled Portfolia</h1>
            <div className={`status-badge ${status.connected ? 'connected' : 'disconnected'}`}>
              {status.connected ? 'Připojeno' : 'Odpojeno'}
            </div>
          </div>

          {status.connected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {reportDate && <div className="report-date">Data: {reportDate}</div>}
              <button
                onClick={handleDisconnect}
                style={{
                  fontSize: '0.8rem',
                  padding: '4px 8px',
                  background: '#444',
                  border: 'none',
                  borderRadius: '4px',
                  color: '#ccc',
                  cursor: 'pointer'
                }}
              >
                Odhlásit
              </button>
            </div>
          )}
        </div>
      </header>

      {!status.connected && (
        <div className="grid">
          <CredentialsForm onConnect={handleConnect} loading={loading} />
          {error && (
            <div className="card" style={{ borderColor: 'var(--danger-color)', borderLeft: '4px solid var(--danger-color)', marginTop: '1rem' }}>
              <h3 style={{ color: 'var(--danger-color)', marginTop: 0 }}>Chyba</h3>
              <p>{error}</p>
            </div>
          )}

          <Instructions />
        </div>
      )}

      {status.connected && accountData && (
        <>
          <div className="responsive-grid">
            {/* Left Column: Stats & Utilization */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', justifyContent: 'space-between' }}>
              <div className="card summary-card">
                <h3>Čistá Likvidace</h3>
                <div className="value">{Number(netLiquidation).toLocaleString('cs-CZ')} CZK</div>
                <div className="subtext">Celková hodnota účtu</div>
              </div>

              <div className="card summary-card">
                <h3>Investovaný Kapitál</h3>
                <div className="value">{Number(totalAllocated).toLocaleString('cs-CZ')} CZK</div>
                <div className="subtext">Aktiva + Blokované opce ({allocatedAlloc}%)</div>
              </div>

              <UtilizationBar
                invested={totalAllocated}
                total={netLiquidation}
              />
            </div>

            {/* Right Column: Chart */}
            <CapitalAllocationChart
              stockValue={stockValueLong}
              cryptoValue={cryptoValue}
              futuresValue={futuresValue}
              optionBlocked={totalCommitedCapital}
              longOptionValue={longOptionValue}
              freeCash={derivedCash}
              total={netLiquidation}
            />
          </div>
        </>
      )}

      {status.connected && accountData && (
        <div className="content-container">
          {/* A large spacer between summary/chart and positions table */}
          <div style={{ height: '3rem' }}></div>

          <PositionTable
            title="Short Puts (Příjem)"
            data={options.filter(o => o.value.type === 'PUT' && o.value.quantity < 0)}
            columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Blokováno $', 'Blokováno CZK', '%']}
            color="#e74c3c"
            netLiquidation={netLiquidation}
          />

          {/* 2. Short Calls (Covered/Income) - Red */}
          <PositionTable
            title="Short Calls (Příjem)"
            data={options.filter(o => o.value.type === 'CALL' && o.value.quantity < 0)}
            color="var(--danger-color)"
            columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
            netLiquidation={netLiquidation}
          />


          {/* 3. Long Puts (Hedge) - Orange */}
          <PositionTable
            title="Long Puts (Zajištění)"
            data={options.filter(o => o.value.type === 'PUT' && o.value.quantity > 0)}
            color="var(--option-color)"
            columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
            netLiquidation={netLiquidation}
          />

          {/* 4. Long Calls (Growth) - Green */}
          <PositionTable
            title="Long Calls (Růst)"
            data={options.filter(o => o.value.type === 'CALL' && o.value.quantity > 0)}
            color="var(--option-color)"
            columns={['Ticker', 'Expirace', 'Strike', 'Typ', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
            netLiquidation={netLiquidation}
          />

          {/* 5. Stocks - Green */}
          <PositionTable
            title="Akcie"
            data={stocks}
            color="var(--primary-color)"
            columns={['Ticker', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
            netLiquidation={netLiquidation}
          />

          {/* 6. Crypto - Gold */}
          <PositionTable
            title="Krypto"
            data={cryptos}
            color="var(--primary-color)"
            columns={['Ticker', 'Asset', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Hodnota $', 'Hodnota CZK', '%']}
            netLiquidation={netLiquidation}
          />

          {/* 7. Futures - Purple */}
          <PositionTable
            title="Futures"
            data={futures}
            color="var(--futures-color)"
            columns={['Ticker', 'Expirace', 'Ks', 'Avg Price', 'Cena', 'P/L', 'Blokováno $', 'Blokováno CZK', '%']}
            netLiquidation={netLiquidation}
          />
        </div>
      )}
    </div>
  );
}
