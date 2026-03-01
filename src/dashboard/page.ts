export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sol-Trader</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0a0e17;
    color: #e1e4e8;
    padding: 20px;
    min-height: 100vh;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #1e2937;
  }
  .header h1 { font-size: 1.5rem; font-weight: 600; color: #58a6ff; }
  .header .badges { display: flex; gap: 8px; align-items: center; }
  .badge-pill {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge-paper { background: #1a3a2a; color: #3fb950; border: 1px solid #238636; }
  .badge-live { background: #3a1a1a; color: #f85149; border: 1px solid #da3633; }
  .badge-watchlist { background: #1a2a3a; color: #58a6ff; border: 1px solid #1f6feb; }
  .updated { font-size: 0.75rem; color: #6e7681; margin-top: 4px; }

  /* Grid */
  .grid { display: grid; gap: 16px; margin-bottom: 24px; }
  .grid-3 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  .grid-4 { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  @media (max-width: 768px) { .grid-3, .grid-4 { grid-template-columns: 1fr; } }

  /* Cards */
  .card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
  }
  .card h3 {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6e7681;
    margin-bottom: 8px;
  }
  .card .value { font-size: 1.8rem; font-weight: 700; line-height: 1.2; }
  .card .sub { font-size: 0.8rem; color: #6e7681; margin-top: 4px; }

  .green { color: #3fb950; }
  .red { color: #f85149; }
  .yellow { color: #d29922; }
  .blue { color: #58a6ff; }
  .muted { color: #484f58; }

  /* Signal panel */
  .signal-panel {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 24px;
  }
  .signal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .signal-header h2 { font-size: 1rem; font-weight: 600; color: #c9d1d9; }
  .signal-source {
    font-size: 0.7rem;
    padding: 2px 8px;
    border-radius: 4px;
    background: #1a2a3a;
    color: #58a6ff;
  }
  .signal-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }
  .signal-card {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .signal-card:hover { border-color: #58a6ff; }
  .signal-card.selected { border-color: #58a6ff; border-width: 2px; }
  .signal-label {
    font-size: 0.85rem;
    font-weight: 600;
    color: #c9d1d9;
    margin-bottom: 2px;
  }
  .signal-mint {
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 0.65rem;
    color: #6e7681;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .signal-mint a { color: #6e7681; text-decoration: none; }
  .signal-mint a:hover { color: #58a6ff; text-decoration: underline; }
  .crsi-display {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 12px;
  }
  .crsi-value { font-size: 2.4rem; font-weight: 800; line-height: 1; }
  .crsi-label { font-size: 0.7rem; color: #6e7681; text-transform: uppercase; letter-spacing: 0.5px; }
  .crsi-sub { font-size: 0.9rem; color: #6e7681; }
  .signal-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.8rem;
    padding: 4px 0;
    border-top: 1px solid #21262d;
  }
  .signal-row:first-of-type { border-top: none; }
  .signal-row .label { color: #6e7681; }

  /* Progress bar */
  .progress-bar {
    height: 6px;
    background: #21262d;
    border-radius: 3px;
    overflow: hidden;
    margin-top: 8px;
  }
  .progress-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s ease;
  }
  .progress-fill.warming { background: linear-gradient(90deg, #d29922, #f0883e); }
  .progress-fill.ready { background: #3fb950; }
  .progress-text {
    font-size: 0.7rem;
    color: #6e7681;
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
  }

  /* Chart */
  .chart-container {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .chart-container h3 {
    font-size: 0.85rem;
    color: #6e7681;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  canvas { width: 100% !important; height: 200px !important; }

  /* Table */
  .table-container {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 24px;
  }
  .table-header {
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    font-size: 0.85rem;
    color: #6e7681;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .table-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .subtle-note {
    font-size: 0.72rem;
    color: #6e7681;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }
  .table-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .filter-btn {
    background: #0d1117;
    border: 1px solid #30363d;
    color: #c9d1d9;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 0.72rem;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .filter-btn:hover { border-color: #58a6ff; }
  .filter-btn.active {
    background: #1a2a3a;
    border-color: #1f6feb;
    color: #58a6ff;
  }
  .table-controls input[type="date"],
  .table-controls select {
    background: #0d1117;
    border: 1px solid #30363d;
    color: #c9d1d9;
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 0.75rem;
  }
  .table-controls input[type="date"]:focus,
  .table-controls select:focus {
    border-color: #58a6ff;
    outline: none;
  }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th {
    text-align: left; padding: 8px 12px; color: #6e7681;
    font-weight: 500; border-bottom: 1px solid #21262d;
    font-size: 0.75rem; text-transform: uppercase;
  }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #1c2128; }
  .mint-link {
    color: #58a6ff; text-decoration: none;
    font-family: 'Consolas', 'Monaco', monospace; font-size: 0.75rem;
  }
  .mint-link:hover { text-decoration: underline; }
  .badge { padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
  .badge.win { background: #1a3a2a; color: #3fb950; }
  .badge.loss { background: #3a1a1a; color: #f85149; }

  /* Open positions */
  .pos-card {
    background: #161b22; border: 1px solid #21262d; border-radius: 8px;
    padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; gap: 16px;
  }
  .pos-mint { font-family: monospace; font-size: 0.8rem; color: #58a6ff; }
  .pos-pnl { font-size: 1.1rem; font-weight: 700; }
  .pos-detail { font-size: 0.75rem; color: #6e7681; }
  .no-data { text-align: center; padding: 40px; color: #484f58; font-size: 0.9rem; }

  section { margin-bottom: 24px; }
  .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 12px; color: #c9d1d9; }
  .section-title.with-subtitle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Sol-Trader</h1>
    <div class="updated" id="lastUpdate">Loading...</div>
  </div>
  <div class="badges">
    <span class="badge-pill badge-watchlist">WATCHLIST</span>
    <span class="badge-pill badge-paper" id="modeLabel">PAPER</span>
    <span class="badge-pill" id="crsiSourceBadge" style="background:#1c1c1c;color:#6e7681;border:1px solid #30363d;">--</span>
    <span class="badge-pill" id="tradeCaptBadge" style="background:#1c1c1c;color:#6e7681;border:1px solid #30363d;">TRADES: --</span>
  </div>
</div>

<!-- CRSI Signal Panel -->
<div class="signal-panel">
  <div class="signal-header">
    <h2>RSI Signals</h2>
  </div>
  <div class="signal-grid" id="signalGrid">
    <div class="no-data">Loading signals...</div>
  </div>
</div>

<!-- Signal QA -->
<section>
  <div class="section-title with-subtitle">
    <span>Signal QA</span>
    <span class="subtle-note" id="signalStatsMeta">Latest signal file</span>
  </div>
  <div class="grid grid-4" id="signalStatsCards"></div>
  <div class="grid" id="signalStatsTables" style="grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));"></div>
</section>

<!-- Price Chart -->
<div class="chart-container">
  <h3 id="chartTitle">Price (1-min candles, 24hr lookback)</h3>
  <canvas id="priceChart"></canvas>
</div>

<!-- Portfolio & Positions -->
<section>
  <div class="section-title">Portfolio</div>
  <div class="grid grid-4" id="portfolio"></div>
  <div id="openPositions" style="display: grid; gap: 8px; margin-top: 12px;">
    <div class="no-data">No open positions</div>
  </div>
</section>

<!-- Performance (hidden until trades exist) -->
<section id="perfSection" style="display:none;">
  <div class="section-title with-subtitle">
    <span>Performance</span>
    <span class="subtle-note" id="perfRange">All time</span>
  </div>
  <div class="grid grid-3" id="perfMetrics"></div>
</section>

<!-- Trade History -->
<section>
  <div class="table-container">
    <div class="table-header">
      <div class="table-header-left">
        <span>Trade History</span>
        <span class="subtle-note" id="tradeRangeLabel">All time</span>
      </div>
      <div class="table-controls">
        <button class="filter-btn active" id="filterAllBtn" onclick="setTradeDateFilter('')">All</button>
        <button class="filter-btn" id="filterTodayBtn" onclick="setTradeDateFilter(dateKeyFromOffset(0))">Today</button>
        <button class="filter-btn" id="filterYesterdayBtn" onclick="setTradeDateFilter(dateKeyFromOffset(-1))">Yesterday</button>
        <select id="tradeMintSelect" onchange="setTradeMintFilter(this.value)">
          <option value="">All tokens</option>
        </select>
        <input type="date" id="tradeDateInput" onchange="setTradeDateFilter(this.value)" />
        <span id="tradeCount">0 trades</span>
      </div>
    </div>
    <div style="max-height: 400px; overflow-y: auto;">
      <table>
        <thead>
          <tr><th>Time</th><th>Mint</th><th>PnL</th><th>PnL %</th><th>Hold</th><th>Exit</th></tr>
        </thead>
        <tbody id="tradeTable">
          <tr><td colspan="6" class="no-data">No trades yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- System Status -->
<section>
  <div class="section-title">System</div>
  <div class="grid grid-4" id="sysStatus"></div>
</section>

<script>
const API = '';
let selectedMint = null;
let signalCache = [];
let latestTrades = [];
let selectedTradeDate = '';
let selectedTradeMint = '';
function fmt(n, d=2) { return n === Infinity || n === -Infinity ? '--' : Number(n).toFixed(d); }
function fmtPct(n) { return fmt(n,1) + '%'; }
function pnlColor(n) { return n > 0 ? 'green' : n < 0 ? 'red' : ''; }
function shortMint(m) { return m.slice(0,4) + '...' + m.slice(-4); }
function labelFor(s) { return s.label || shortMint(s.mint); }
function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-GB', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function crsiColor(v, threshold) {
  if (v === undefined || v === null) return 'muted';
  if (v <= threshold) return 'green';
  if (v <= threshold * 2) return 'yellow';
  return 'muted';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtParamValue(v) {
  if (!isFiniteNumber(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return Number(v).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
function formatStrategyParams(params) {
  if (!params || typeof params !== 'object') return '--';
  const entries = Object.entries(params).filter(([, v]) => isFiniteNumber(v));
  if (entries.length === 0) return '--';
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => k + '=' + fmtParamValue(v)).join(' ');
}
function escapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function toDateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function dateKeyFromOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function formatDateKey(key) {
  if (!key) return 'All time';
  const parts = key.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 'All time';
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function tokenNameFromMint(mint) {
  const sig = signalCache.find(s => s.mint === mint);
  return sig ? labelFor(sig) : shortMint(mint);
}
function formatTradeRangeLabel() {
  const dateLabel = formatDateKey(selectedTradeDate);
  const tokenLabel = selectedTradeMint ? tokenNameFromMint(selectedTradeMint) : 'All tokens';
  return dateLabel + ' | ' + tokenLabel;
}
function normalizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades
    .filter(t =>
      t &&
      typeof t.mint === 'string' &&
      isFiniteNumber(t.exitTime) &&
      isFiniteNumber(t.pnlUsdc) &&
      isFiniteNumber(t.pnlPct) &&
      isFiniteNumber(t.holdTimeMinutes)
    )
    .map(t => ({
      ...t,
      exitTime: Number(t.exitTime),
      pnlUsdc: Number(t.pnlUsdc),
      pnlPct: Number(t.pnlPct),
      holdTimeMinutes: Number(t.holdTimeMinutes),
    }));
}
function filterTradesByDate(trades) {
  return trades.filter(t => {
    if (selectedTradeDate && toDateKey(t.exitTime) !== selectedTradeDate) return false;
    if (selectedTradeMint && t.mint !== selectedTradeMint) return false;
    return true;
  });
}
function updateTradeMintOptions(trades) {
  const select = document.getElementById('tradeMintSelect');
  if (!select) return;
  const counts = new Map();
  for (const t of trades) {
    counts.set(t.mint, (counts.get(t.mint) || 0) + 1);
  }
  const options = Array.from(counts.keys())
    .map(mint => ({
      mint,
      label: tokenNameFromMint(mint),
      count: counts.get(mint) || 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  select.innerHTML = '<option value="">All tokens</option>' +
    options.map(o => '<option value="' + o.mint + '">' + o.label + ' (' + o.count + ')</option>').join('');

  if (selectedTradeMint && !counts.has(selectedTradeMint)) {
    selectedTradeMint = '';
  }
  select.value = selectedTradeMint;
}
function syncTradeFilterButtons() {
  const allBtn = document.getElementById('filterAllBtn');
  const todayBtn = document.getElementById('filterTodayBtn');
  const ydayBtn = document.getElementById('filterYesterdayBtn');
  const dateInput = document.getElementById('tradeDateInput');
  const mintSelect = document.getElementById('tradeMintSelect');
  const today = dateKeyFromOffset(0);
  const yday = dateKeyFromOffset(-1);
  if (dateInput) dateInput.value = selectedTradeDate;
  if (mintSelect) mintSelect.value = selectedTradeMint;
  if (allBtn) allBtn.classList.toggle('active', !selectedTradeDate);
  if (todayBtn) todayBtn.classList.toggle('active', selectedTradeDate === today);
  if (ydayBtn) ydayBtn.classList.toggle('active', selectedTradeDate === yday);
}
function setTradeDateFilter(dateKey) {
  selectedTradeDate = dateKey || '';
  syncTradeFilterButtons();
  renderTradePanels();
}
function setTradeMintFilter(mint) {
  selectedTradeMint = mint || '';
  syncTradeFilterButtons();
  renderTradePanels();
}
function computeTradeStats(trades) {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return {
      totalTrades: 0, winRate: 0, profitFactor: 0, totalPnlUsdc: 0,
      maxDrawdownPct: 0, sharpeRatio: 0, avgHoldTimeMinutes: 0,
    };
  }
  const wins = trades.filter(t => t.pnlUsdc > 0);
  const losses = trades.filter(t => t.pnlUsdc <= 0);
  const winRate = (wins.length / totalTrades) * 100;
  const totalPnlUsdc = trades.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const totalWinUsdc = wins.reduce((sum, t) => sum + t.pnlUsdc, 0);
  const totalLossUsdc = Math.abs(losses.reduce((sum, t) => sum + t.pnlUsdc, 0));
  const profitFactor = totalLossUsdc > 0 ? totalWinUsdc / totalLossUsdc : (totalWinUsdc > 0 ? Infinity : 0);

  let peak = 0;
  let maxDrawdownPct = 0;
  let cumPnl = 0;
  const chronological = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of chronological) {
    cumPnl += t.pnlUsdc;
    if (cumPnl > peak) peak = cumPnl;
    if (peak > 0) {
      const dd = ((peak - cumPnl) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const returns = trades.map(t => t.pnlPct / 100);
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(totalTrades) : 0;
  const avgHoldTimeMinutes = trades.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / totalTrades;

  return { totalTrades, winRate, profitFactor, totalPnlUsdc, maxDrawdownPct, sharpeRatio, avgHoldTimeMinutes };
}
function renderTradePanels() {
  const filtered = filterTradesByDate(latestTrades);
  renderPerformance(filtered);
  renderTrades(filtered, latestTrades.length);
}

async function fetchAll() {
  try {
    const chartParam = selectedMint ? '?mint=' + selectedMint : '';
    const [signals, chart, status, metrics, trades, signalStats] = await Promise.all([
      fetch(API + '/api/signals').then(r => r.json()),
      fetch(API + '/api/price-chart' + chartParam).then(r => r.json()),
      fetch(API + '/api/status').then(r => r.json()),
      fetch(API + '/api/metrics').then(r => r.json()),
      fetch(API + '/api/trades').then(r => r.json()),
      fetch(API + '/api/signal-stats').then(r => r.json()),
    ]);
    signalCache = signals;
    renderSignals(signals);
    const chartLabel = selectedMint
      ? (signals.find(s => s.mint === selectedMint)?.label || shortMint(selectedMint))
      : (signals[0]?.label || (signals[0] ? shortMint(signals[0].mint) : ''));
    renderPriceChart(chart, chartLabel);
    renderPortfolio(status);
    latestTrades = normalizeTrades(trades);
    updateTradeMintOptions(latestTrades);
    syncTradeFilterButtons();
    renderTradePanels();
    renderSignalStats(signalStats, signals);
    renderSystem(status, metrics, signals);
    renderBadges(status, signals);
    document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Dashboard fetch failed:', err);
    document.getElementById('lastUpdate').textContent = 'Update failed: ' + err.message;
  }
}

function renderSignals(signals) {
  const el = document.getElementById('signalGrid');
  if (!signals || signals.length === 0) {
    el.innerHTML = '<div class="no-data">No watchlist tokens configured</div>';
    return;
  }

  el.innerHTML = signals.map((s, i) => {
    const hasRsi = s.rsi !== undefined && s.rsi !== null;
    const rsiVal = hasRsi ? fmt(s.rsi, 1) : '--';
    const rsiCls = crsiColor(s.rsi, s.oversoldThreshold);
    const priceFmt = s.priceUsd > 0 ? '$' + (s.priceUsd < 0.01 ? s.priceUsd.toExponential(2) : fmt(s.priceUsd, 4)) : '--';
    const pct = Math.min(100, Math.round((s.candleCount / s.candlesNeeded) * 100));
    const timeframeMinutes = isFiniteNumber(s.timeframeMinutes) && s.timeframeMinutes > 0 ? s.timeframeMinutes : 1;
    const minsLeft = Math.max(0, (s.candlesNeeded - s.candleCount) * timeframeMinutes);
    const etaLabel = minsLeft >= 120 ? ('~' + (minsLeft / 60).toFixed(1) + 'h') : ('~' + Math.round(minsLeft) + ' min');
    const readyLabel = s.ready ? 'Ready' : 'Warming up (' + etaLabel + ')';
    const barCls = s.ready ? 'ready' : 'warming';
    const signalLabel = hasRsi && s.rsi <= s.oversoldThreshold
      ? '<span class="green" style="font-weight:700;font-size:0.8rem;">OVERSOLD</span>'
      : '';
    const indicatorLabel = s.indicatorKind === 'rsi' ? 'RSI(14)' : 'CRSI';
    const regimeColor = s.trendRegime === 'uptrend' ? '#3fb950' : s.trendRegime === 'downtrend' ? '#f85149' : s.trendRegime === 'sideways' ? '#d29922' : '#484f58';
    const regimeBadge = '<span style="margin-left:6px;font-size:0.6rem;padding:1px 5px;border-radius:3px;background:#0d1117;color:' + regimeColor + ';border:1px solid ' + regimeColor + '40;vertical-align:middle;">' + (s.trendRegime || '--') + '</span>';
    const regimeScore = s.trendScore !== null ? '<div class="signal-row" style="margin-top:8px;border-top:1px solid #21262d;padding-top:6px;"><span class="label">Trend score</span><span style="color:' + regimeColor + ';">' + Number(s.trendScore).toFixed(1) + (s.ret24h !== null ? ' | 24h ' + (s.ret24h >= 0 ? '+' : '') + Number(s.ret24h).toFixed(1) + '%' : '') + (s.ret72h !== null ? ' | 72h ' + (s.ret72h >= 0 ? '+' : '') + Number(s.ret72h).toFixed(1) + '%' : '') + '</span></div>' : '';
    const isSelected = selectedMint ? s.mint === selectedMint : i === 0;
    const cardBorderColor = !s.masterEnabled ? '#f85149' : s.regimeActive ? '#3fb950' : '#21262d';
    const statusText = !s.masterEnabled ? 'Master: disabled' : s.regimeActive ? (s.trendRegime || 'unknown') + ': active' : (s.trendRegime || 'unknown') + ': no strategy';
    const statusColor = !s.masterEnabled ? '#f85149' : s.regimeActive ? '#3fb950' : '#6e7681';
    const strategySummary = s.templateId
      ? (
          (s.routeId || s.templateId) +
          ' | ' + (s.timeframeMinutes ? (s.timeframeMinutes + 'm') : '--') +
          ' | ' + (s.exitMode || 'price') +
          (isFiniteNumber(s.routePriority) ? (' | p' + fmt(s.routePriority, 0)) : '')
        )
      : '--';
    const paramsText = formatStrategyParams(s.strategyParams);
    const stopsText = (isFiniteNumber(s.sl) && isFiniteNumber(s.tp))
      ? ('SL ' + fmt(s.sl, 2) + '% / TP ' + fmt(s.tp, 2) + '%')
      : '--';
    const maxSizeText = (isFiniteNumber(s.tokenMaxEquityPct))
      ? (fmt(s.tokenMaxEquityPct, 2) + '% equity' + (isFiniteNumber(s.tokenMaxUsdc) ? (' (cap ' + fmt(s.tokenMaxUsdc, 2) + ' USDC)') : ''))
      : (isFiniteNumber(s.tokenMaxUsdc) ? (fmt(s.tokenMaxUsdc, 2) + ' USDC') : '--');
    return '<div class="signal-card' + (isSelected ? ' selected' : '') + '" data-mint="' + s.mint + '" style="border-color:' + cardBorderColor + ';" onclick="selectToken(\\''+s.mint+'\\');event.stopPropagation();">' +
      '<div class="signal-label">' + labelFor(s) + ' ' + signalLabel + regimeBadge + '</div>' +
      '<div class="signal-mint">' +
        '<a href="https://solscan.io/token/' + s.mint + '" target="_blank" onclick="event.stopPropagation();">' + shortMint(s.mint) + '</a>' +
      '</div>' +
      '<div class="crsi-display">' +
        '<div><div class="crsi-label">' + indicatorLabel + '</div><div class="crsi-value ' + rsiCls + '">' + rsiVal + '</div></div>' +
        '<div><div class="crsi-label">Price</div><div class="crsi-sub">' + priceFmt + '</div></div>' +
      '</div>' +
      '<div class="progress-bar"><div class="progress-fill ' + barCls + '" style="width:' + pct + '%"></div></div>' +
      '<div class="progress-text"><span>' + readyLabel + '</span><span>' + s.candleCount + ' / ' + s.candlesNeeded + ' @ ' + timeframeMinutes + 'm</span></div>' +
      regimeScore +
      '<div style="margin-top:8px;border-top:1px solid #21262d;padding-top:8px;">' +
        '<div style="font-size:0.7rem;color:#6e7681;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Position</div>' +
        '<div class="signal-row"><span class="label">Pool liquidity</span><span>' + (s.liquidityUsd > 0 ? '$' + Number(s.liquidityUsd).toLocaleString('en-US', {maximumFractionDigits:0}) : '--') + '</span></div>' +
        '<div class="signal-row"><span class="label">Max size</span><span class="blue">' + maxSizeText + '</span></div>' +
        '<div class="signal-row"><span class="label">Last impact</span><span class="' + (s.quotedImpact !== undefined && s.quotedImpact > s.maxEntryImpactPct ? 'red' : 'green') + '">' + (s.quotedImpact !== undefined ? fmt(s.quotedImpact, 4) + '%' : 'N/A') + '</span></div>' +
        '<div class="signal-row" style="margin-top:6px;border-top:1px solid #21262d;padding-top:6px;"><span class="label">Status</span><span style="color:' + statusColor + ';font-size:0.75rem;">' + statusText + '</span></div>' +
        '<div class="signal-row"><span class="label">Live strategy</span><span style="font-family:Consolas,Monaco,monospace;font-size:0.72rem;color:#c9d1d9;">' + strategySummary + '</span></div>' +
        '<div class="signal-row"><span class="label">Params</span><span style="font-family:Consolas,Monaco,monospace;font-size:0.72rem;color:#c9d1d9;">' + paramsText + '</span></div>' +
        '<div class="signal-row"><span class="label">Stops</span><span style="font-size:0.75rem;color:#c9d1d9;">' + stopsText + '</span></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function selectToken(mint) {
  selectedMint = mint;
  // Re-render cards to update selection highlight
  renderSignals(signalCache);
  // Fetch new chart data for selected token
  fetch(API + '/api/price-chart?mint=' + mint).then(r => r.json()).then(points => {
    const sig = signalCache.find(s => s.mint === mint);
    renderPriceChart(points, sig ? labelFor(sig) : shortMint(mint));
  });
}

function renderPriceChart(points, tokenLabel) {
  const titleEl = document.getElementById('chartTitle');
  titleEl.textContent = (tokenLabel || '') + ' \u2014 Price (1-min candles, 24hr lookback)';
  const canvas = document.getElementById('priceChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width - 32;
  const h = 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!points || points.length < 2) {
    ctx.fillStyle = '#484f58';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting price data...', w/2, h/2);
    return;
  }

  const prices = points.map(p => p.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP || 1;
  const pad = 60;

  // Y axis labels
  ctx.fillStyle = '#6e7681';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('$' + fmt(maxP, 4), pad - 4, 14);
  ctx.fillText('$' + fmt(minP, 4), pad - 4, h - 4);
  const midP = (maxP + minP) / 2;
  const midY = pad / 2 + (h - pad) * (1 - (midP - minP) / range);
  ctx.fillText('$' + fmt(midP, 4), pad - 4, midY + 4);

  // X axis time labels
  ctx.textAlign = 'center';
  const first = points[0].time;
  const last = points[points.length - 1].time;
  ctx.fillText(new Date(first).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}), pad, h - 4);
  ctx.fillText(new Date(last).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}), w - 10, h - 4);

  // Grid line at midpoint
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Price line
  ctx.beginPath();
  const plotH = h - pad;
  const stepX = (w - pad) / (points.length - 1);
  for (let i = 0; i < points.length; i++) {
    const x = pad + i * stepX;
    const y = pad / 2 + plotH * (1 - (points[i].price - minP) / range);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const lastPrice = prices[prices.length - 1];
  const firstPrice = prices[0];
  const up = lastPrice >= firstPrice;
  ctx.strokeStyle = up ? '#3fb950' : '#f85149';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fill under curve
  const lastX = pad + (points.length - 1) * stepX;
  ctx.lineTo(lastX, h - pad / 2);
  ctx.lineTo(pad, h - pad / 2);
  ctx.closePath();
  ctx.fillStyle = up ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)';
  ctx.fill();

  // Current price label
  const lastY = pad / 2 + plotH * (1 - (lastPrice - minP) / range);
  ctx.fillStyle = up ? '#3fb950' : '#f85149';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText('$' + fmt(lastPrice, 4), lastX + 4, lastY - 4);
}

function renderPortfolio(s) {
  const el = document.getElementById('portfolio');
  const wb = s.walletBalances || {};
  const solPrice = s.solPriceUsd || 0;
  const solUsd = (wb.sol || 0) * solPrice;
  // Compute open positions notional: initialSizeUsdc * remainingPct/100 * (1 + pnlPct/100)
  const openNotional = (s.openPositions || []).reduce((sum, p) => {
    return sum + (p.initialSizeUsdc || 0) * (p.remainingPct / 100) * (1 + p.pnlPct / 100);
  }, 0);
  const totalEquity = (wb.usdc || 0) + solUsd + openNotional;

  const cards = [
    {
      label: 'USDC (wallet)',
      value: fmt(wb.usdc ?? 0, 2) + ' USDC',
      sub: 'Idle capital',
      cls: 'blue',
    },
    {
      label: 'SOL (wallet)',
      value: fmt(wb.sol ?? 0, 3) + ' SOL',
      sub: solPrice > 0 ? '~ $' + fmt(solUsd, 2) : '--',
      cls: 'blue',
    },
    {
      label: 'Open Trades',
      value: s.openPositions.length,
      sub: openNotional > 0 ? '~ $' + fmt(openNotional, 2) + ' notional' : 'No open positions',
      cls: s.openPositions.length > 0 ? 'yellow' : '',
    },
    {
      label: 'Daily PnL',
      value: fmtPct(s.portfolio.dailyPnlPct),
      sub: 'Total equity ~ $' + fmt(totalEquity, 2),
      cls: pnlColor(s.portfolio.dailyPnlPct),
    },
  ];
  el.innerHTML = cards.map(c =>
    '<div class="card"><h3>' + c.label + '</h3><div class="value ' + c.cls + '">' + c.value + '</div>' +
    (c.sub ? '<div class="sub">' + c.sub + '</div>' : '') + '</div>'
  ).join('');

  const posEl = document.getElementById('openPositions');
  if (s.openPositions.length === 0) {
    posEl.innerHTML = '<div class="no-data">No open positions</div>';
  } else {
    posEl.innerHTML = s.openPositions.map(p => {
      const sig = signalCache.find(sc => sc.mint === p.mint);
      const name = sig ? labelFor(sig) : shortMint(p.mint);
      return '<div class="pos-card">' +
      '<div><div class="pos-mint">' + name + '</div>' +
      '<div class="pos-detail">Entry: $' + fmt(p.entryPrice, p.entryPrice < 0.01 ? 6 : p.entryPrice < 1 ? 4 : 2) + ' | Hold: ' + p.holdTimeMins + 'm | Remaining: ' + fmt(p.remainingPct,0) + '%' +
      (p.tp1Hit ? ' | TP1' : '') + '</div></div>' +
      '<div class="pos-pnl ' + pnlColor(p.pnlPct) + '">' + (p.pnlPct >= 0 ? '+' : '') + fmtPct(p.pnlPct) + '</div>' +
      '</div>';
    }).join('');
  }
}

function renderPerformance(trades) {
  const stats = computeTradeStats(trades);
  const section = document.getElementById('perfSection');
  const rangeEl = document.getElementById('perfRange');
  if (rangeEl) rangeEl.textContent = formatTradeRangeLabel();
  if (stats.totalTrades === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const el = document.getElementById('perfMetrics');
  const cards = [
    { label: 'Total Trades', value: stats.totalTrades, cls: 'blue' },
    { label: 'Win Rate', value: fmtPct(stats.winRate), cls: stats.winRate >= 50 ? 'green' : 'red' },
    { label: 'Profit Factor', value: fmt(stats.profitFactor), cls: stats.profitFactor >= 1.25 ? 'green' : 'red' },
    { label: 'Total PnL', value: fmt(stats.totalPnlUsdc, 2) + ' USDC', cls: pnlColor(stats.totalPnlUsdc) },
    { label: 'Max Drawdown', value: fmtPct(stats.maxDrawdownPct), cls: stats.maxDrawdownPct <= 10 ? 'green' : 'red' },
    { label: 'Avg Hold', value: fmt(stats.avgHoldTimeMinutes, 1) + 'm', cls: 'blue' },
  ];
  el.innerHTML = cards.map(c =>
    '<div class="card"><h3>' + c.label + '</h3><div class="value ' + c.cls + '">' + c.value + '</div></div>'
  ).join('');
}

function renderTrades(trades, totalTrades) {
  const el = document.getElementById('tradeTable');
  const total = Number.isFinite(totalTrades) ? totalTrades : trades.length;
  const hasFilter = !!selectedTradeDate || !!selectedTradeMint;
  const countText = hasFilter ? (trades.length + ' / ' + total + ' trades') : (total + ' trades');
  document.getElementById('tradeCount').textContent = countText;
  const rangeEl = document.getElementById('tradeRangeLabel');
  if (rangeEl) rangeEl.textContent = formatTradeRangeLabel();
  if (trades.length === 0) {
    el.innerHTML = '<tr><td colspan="6" class="no-data">No trades yet</td></tr>';
    return;
  }
  const sorted = [...trades].sort((a, b) => b.exitTime - a.exitTime);
  el.innerHTML = sorted.map(t => {
    const isWin = t.pnlUsdc > 0;
    const sig = signalCache.find(sc => sc.mint === t.mint);
    const name = sig ? labelFor(sig) : shortMint(t.mint);
    return '<tr>' +
      '<td>' + fmtDate(t.exitTime) + '</td>' +
      '<td><a class="mint-link" href="https://solscan.io/token/' + t.mint + '" target="_blank">' + name + '</a></td>' +
      '<td class="' + pnlColor(t.pnlUsdc) + '">' + (t.pnlUsdc >= 0 ? '+' : '') + fmt(t.pnlUsdc, 4) + '</td>' +
      '<td><span class="badge ' + (isWin ? 'win' : 'loss') + '">' + (t.pnlPct >= 0 ? '+' : '') + fmtPct(t.pnlPct) + '</span></td>' +
      '<td>' + Math.round(t.holdTimeMinutes) + 'm</td>' +
      '<td>' + t.exitType + '</td>' +
      '</tr>';
  }).join('');
}

function renderMiniStatsTable(title, columns, rows) {
  const head = columns.map(c => '<th>' + c.label + '</th>').join('');
  const body = rows.length === 0
    ? '<tr><td colspan="' + columns.length + '" class="no-data" style="padding:20px;">No data</td></tr>'
    : rows.slice(0, 10).map(row => {
        const tds = columns.map(c => {
          const raw = c.render ? c.render(row) : row[c.key];
          return '<td>' + raw + '</td>';
        }).join('');
        return '<tr>' + tds + '</tr>';
      }).join('');

  return '<div class="table-container">' +
    '<div class="table-header">' + title + '</div>' +
    '<div style="max-height:280px; overflow-y:auto;"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    '</div>';
}

function renderSignalStats(stats, signals) {
  const cardsEl = document.getElementById('signalStatsCards');
  const tablesEl = document.getElementById('signalStatsTables');
  const metaEl = document.getElementById('signalStatsMeta');
  if (!cardsEl || !tablesEl || !metaEl) return;

  if (!stats || !isFiniteNumber(stats.totalSignals) || stats.totalSignals <= 0) {
    metaEl.textContent = (stats && stats.file) ? (stats.file + ' | no rows') : 'No signal file';
    cardsEl.innerHTML = [
      '<div class="card"><h3>Total Signals</h3><div class="value blue">0</div><div class="sub">Latest jsonl empty or missing</div></div>',
      '<div class="card"><h3>Accepted</h3><div class="value green">0</div></div>',
      '<div class="card"><h3>Rejected</h3><div class="value red">0</div></div>',
      '<div class="card"><h3>Acceptance Rate</h3><div class="value muted">0.0%</div></div>',
    ].join('');
    tablesEl.innerHTML = '';
    return;
  }

  const updated = isFiniteNumber(stats.updatedAt) ? fmtDate(stats.updatedAt) : '--';
  metaEl.textContent = (stats.file || 'latest') + ' | updated ' + updated;

  const total = Number(stats.totalSignals || 0);
  const accepted = Number(stats.acceptedSignals || 0);
  const rejected = Number(stats.rejectedSignals || 0);
  const acceptRate = Number(stats.acceptanceRatePct || 0);

  cardsEl.innerHTML = [
    '<div class="card"><h3>Total Signals</h3><div class="value blue">' + total + '</div><div class="sub">' + (stats.uniqueMints || 0) + ' mints</div></div>',
    '<div class="card"><h3>Accepted</h3><div class="value green">' + accepted + '</div></div>',
    '<div class="card"><h3>Rejected</h3><div class="value red">' + rejected + '</div><div class="sub">' + (stats.uniqueRejectReasons || 0) + ' unique reasons</div></div>',
    '<div class="card"><h3>Acceptance Rate</h3><div class="value ' + (acceptRate >= 10 ? 'green' : 'yellow') + '">' + fmtPct(acceptRate) + '</div></div>',
  ].join('');

  const reasonGroups = Array.isArray(stats.rejectGroupStats) ? stats.rejectGroupStats : [];
  const rawReasons = Array.isArray(stats.rejectReasonStats) ? stats.rejectReasonStats : [];
  const routes = Array.isArray(stats.routeRejectStats) ? stats.routeRejectStats : [];
  const mintStats = Array.isArray(stats.byMintStats) ? stats.byMintStats : [];

  const tables = [
    renderMiniStatsTable('Reject Groups', [
      { label: 'Group', key: 'group', render: r => '<span title="' + escapeHtml(r.group || '') + '">' + escapeHtml(r.group || '--') + '</span>' },
      { label: 'Count', key: 'count', render: r => Number(r.count || 0).toLocaleString() },
      { label: '% Rejects', key: 'pct', render: r => fmt(r.pct || 0, 1) + '%' },
    ], reasonGroups),
    renderMiniStatsTable('Top Reject Reasons', [
      { label: 'Reason', key: 'reason', render: r => '<span title="' + escapeHtml(r.reason || '') + '" style="display:inline-block;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(r.reason || '--') + '</span>' },
      { label: 'Count', key: 'count', render: r => Number(r.count || 0).toLocaleString() },
      { label: '% Rejects', key: 'pct', render: r => fmt(r.pct || 0, 1) + '%' },
    ], rawReasons),
    renderMiniStatsTable('Route Rejects', [
      { label: 'Route', key: 'route', render: r => '<span title="' + escapeHtml(r.route || '') + '">' + escapeHtml(r.route || '--') + '</span>' },
      { label: 'Count', key: 'count', render: r => Number(r.count || 0).toLocaleString() },
      { label: '% Rejects', key: 'pct', render: r => fmt(r.pct || 0, 1) + '%' },
    ], routes),
    renderMiniStatsTable('Signals By Mint', [
      { label: 'Mint', key: 'mint', render: r => escapeHtml(tokenNameFromMint(r.mint || '')) },
      { label: 'Total', key: 'total', render: r => Number(r.total || 0).toLocaleString() },
      { label: 'Accepted', key: 'accepted', render: r => '<span class="green">' + Number(r.accepted || 0).toLocaleString() + '</span>' },
      { label: 'Acc %', key: 'acceptanceRatePct', render: r => fmt(r.acceptanceRatePct || 0, 1) + '%' },
    ], mintStats),
  ];

  tablesEl.innerHTML = tables.join('');
}

function renderSystem(status, metrics, signals) {
  const el = document.getElementById('sysStatus');
  const totalPricePoints = signals ? signals.reduce((s, sig) => s + sig.pricePoints, 0) : 0;
  const cards = [
    { label: 'Price Feed Points', value: totalPricePoints, cls: totalPricePoints > 0 ? 'green' : 'yellow' },
    { label: 'Trade Subscriptions', value: status.tradeSubscriptions, cls: '' },
    { label: 'Uptime', value: fmt(metrics.uptimeHours, 1) + 'h', cls: 'blue' },
    { label: 'Watchlist Tokens', value: signals ? signals.length : 0, cls: '' },
  ];
  el.innerHTML = cards.map(c =>
    '<div class="card"><h3>' + c.label + '</h3><div class="value ' + c.cls + '">' + c.value + '</div></div>'
  ).join('');
}

function renderBadges(status, signals) {
  // PAPER/LIVE badge
  const modeBadge = document.getElementById('modeLabel');
  modeBadge.textContent = status.isPaperTrading ? 'PAPER' : 'LIVE';
  modeBadge.className = 'badge-pill ' + (status.isPaperTrading ? 'badge-paper' : 'badge-live');
  // Signal source badge
  const srcBadge = document.getElementById('crsiSourceBadge');
  const source = signals && signals.length > 0 ? signals[0].source : 'none';
  srcBadge.textContent = source.toUpperCase();
  if (source === 'price-feed') {
    srcBadge.style.background = '#1a3a2a'; srcBadge.style.color = '#3fb950'; srcBadge.style.borderColor = '#238636';
  } else {
    srcBadge.style.background = '#1c1c1c'; srcBadge.style.color = '#6e7681'; srcBadge.style.borderColor = '#30363d';
  }
  // Trade capture badge
  const tcBadge = document.getElementById('tradeCaptBadge');
  const tc = status.tradeCapture || 'unknown';
  tcBadge.textContent = 'TRADES: ' + tc.toUpperCase();
  if (tc === 'active') {
    tcBadge.style.background = '#1a3a2a'; tcBadge.style.color = '#3fb950'; tcBadge.style.borderColor = '#238636';
  } else {
    tcBadge.style.background = '#1c1c1c'; tcBadge.style.color = '#6e7681'; tcBadge.style.borderColor = '#30363d';
  }
}

// Initial fetch + auto-refresh every 30s
syncTradeFilterButtons();
fetchAll();
setInterval(fetchAll, 30000);
</script>
</body>
</html>`;
}

