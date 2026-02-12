export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sol-Trader Dashboard</title>
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
  .header h1 {
    font-size: 1.5rem;
    font-weight: 600;
    color: #58a6ff;
  }
  .header .mode {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .mode.paper { background: #1a3a2a; color: #3fb950; border: 1px solid #238636; }
  .mode.live { background: #3a1a1a; color: #f85149; border: 1px solid #da3633; }
  .updated {
    font-size: 0.75rem;
    color: #6e7681;
  }

  /* Grid layout */
  .grid { display: grid; gap: 16px; margin-bottom: 24px; }
  .grid-4 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  @media (max-width: 768px) {
    .grid-2 { grid-template-columns: 1fr; }
  }

  /* Cards */
  .card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
  }
  .card h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #6e7681;
    margin-bottom: 8px;
  }
  .card .value {
    font-size: 1.8rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .card .sub {
    font-size: 0.8rem;
    color: #6e7681;
    margin-top: 4px;
  }

  .green { color: #3fb950; }
  .red { color: #f85149; }
  .yellow { color: #d29922; }
  .blue { color: #58a6ff; }

  /* Gates */
  .gates-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .gate {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 12px 16px;
  }
  .gate-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    flex-shrink: 0;
  }
  .gate-icon.pass { background: #1a3a2a; color: #3fb950; }
  .gate-icon.fail { background: #3a1a1a; color: #f85149; }
  .gate-icon.wait { background: #2a2a1a; color: #d29922; }
  .gate-info { flex: 1; }
  .gate-name { font-size: 0.85rem; font-weight: 500; }
  .gate-detail { font-size: 0.75rem; color: #6e7681; margin-top: 2px; }

  /* Chart */
  .chart-container {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 16px;
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
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    color: #6e7681;
    font-weight: 500;
    border-bottom: 1px solid #21262d;
    font-size: 0.75rem;
    text-transform: uppercase;
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    font-variant-numeric: tabular-nums;
  }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #1c2128; }
  .mint-link {
    color: #58a6ff;
    text-decoration: none;
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 0.75rem;
  }
  .mint-link:hover { text-decoration: underline; }
  .badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge.win { background: #1a3a2a; color: #3fb950; }
  .badge.loss { background: #3a1a1a; color: #f85149; }

  /* Open positions */
  .pos-card {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 8px;
    padding: 12px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .pos-mint { font-family: monospace; font-size: 0.8rem; color: #58a6ff; }
  .pos-pnl { font-size: 1.1rem; font-weight: 700; }
  .pos-detail { font-size: 0.75rem; color: #6e7681; }
  .no-data {
    text-align: center;
    padding: 40px;
    color: #484f58;
    font-size: 0.9rem;
  }

  /* Section headers */
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 12px;
    color: #c9d1d9;
  }
  section { margin-bottom: 24px; }

  /* Exit type bar */
  .exit-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .exit-seg { height: 100%; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Sol-Trader</h1>
    <div class="updated" id="lastUpdate">Loading...</div>
  </div>
  <span class="mode paper" id="modeLabel">PAPER</span>
</div>

<!-- Go-Live Gates -->
<section>
  <div class="section-title">Go-Live Gates</div>
  <div class="gates-grid" id="gates">
    <div class="no-data">Loading gates...</div>
  </div>
</section>

<!-- Key Metrics -->
<section>
  <div class="section-title">Performance</div>
  <div class="grid grid-4" id="metrics">
    <div class="no-data">Loading metrics...</div>
  </div>
</section>

<!-- Equity Curve + Exit Distribution -->
<section>
  <div class="grid grid-2">
    <div class="chart-container">
      <h3>Equity Curve (cumulative PnL)</h3>
      <canvas id="equityChart"></canvas>
    </div>
    <div class="chart-container">
      <h3>Exit Type Distribution</h3>
      <div id="exitDist"><div class="no-data">No trades yet</div></div>
    </div>
  </div>
</section>

<!-- Open Positions -->
<section>
  <div class="section-title">Open Positions</div>
  <div id="openPositions" style="display: grid; gap: 8px;">
    <div class="no-data">No open positions</div>
  </div>
</section>

<!-- Trade History -->
<section>
  <div class="table-container">
    <div class="table-header">
      <span>Trade History</span>
      <span id="tradeCount">0 trades</span>
    </div>
    <div style="max-height: 400px; overflow-y: auto;">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Mint</th>
            <th>PnL</th>
            <th>PnL %</th>
            <th>Hold</th>
            <th>Exit Type</th>
          </tr>
        </thead>
        <tbody id="tradeTable">
          <tr><td colspan="6" class="no-data">No trades yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<!-- Live Status -->
<section>
  <div class="section-title">System Status</div>
  <div class="grid grid-4" id="sysStatus">
    <div class="no-data">Loading...</div>
  </div>
</section>

<script>
const API = '';
let equityCtx = null;

function fmt(n, d=2) { return n === Infinity ? '∞' : Number(n).toFixed(d); }
function fmtPct(n) { return fmt(n,1) + '%'; }
function pnlColor(n) { return n > 0 ? 'green' : n < 0 ? 'red' : ''; }
function shortMint(m) { return m.slice(0,4) + '...' + m.slice(-4); }
function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-GB', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

const EXIT_COLORS = {
  hard_stop: '#f85149', tp1: '#3fb950', tp2: '#56d364', trailing_stop: '#d29922',
  time_stop: '#6e7681', emergency_lp: '#f0883e', runner: '#a5d6ff',
};

async function fetchAll() {
  try {
    const [metrics, gates, status, trades, curve] = await Promise.all([
      fetch(API + '/api/metrics').then(r => r.json()),
      fetch(API + '/api/gates').then(r => r.json()),
      fetch(API + '/api/status').then(r => r.json()),
      fetch(API + '/api/trades').then(r => r.json()),
      fetch(API + '/api/equity-curve').then(r => r.json()),
    ]);
    renderGates(gates, metrics);
    renderMetrics(metrics);
    renderStatus(status);
    renderTrades(trades);
    renderEquityCurve(curve);
    renderExitDist(metrics.exitTypeDistribution || {});
    document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Dashboard fetch failed:', err);
    document.getElementById('lastUpdate').textContent = 'Update failed: ' + err.message;
  }
}

function renderGates(gates, metrics) {
  const el = document.getElementById('gates');
  const gateList = [
    { name: 'Minimum Trades', ...gates.minTrades, fmt: v => Math.round(v) + ' / ' + gates.minTrades.required },
    { name: 'Profit Factor', ...gates.profitFactor, fmt: v => fmt(v) + ' / ' + gates.profitFactor.required },
    { name: 'Win Rate', ...gates.winRate, fmt: v => fmtPct(v) + ' / ' + gates.winRate.required + '%' },
    { name: 'Avg Win/Loss', ...gates.avgWinLoss, fmt: v => fmt(v) + ' / ' + gates.avgWinLoss.required },
    { name: 'Max Drawdown', ...gates.maxDrawdown, fmt: v => fmtPct(v) + ' / ' + gates.maxDrawdown.required + '%' },
    { name: 'Exec Failure Rate', ...gates.execFailRate, fmt: v => fmtPct(v) + ' / ' + gates.execFailRate.required + '%' },
  ];

  const noData = metrics.totalTrades === 0;
  el.innerHTML = gateList.map(g => {
    const cls = noData ? 'wait' : (g.passed ? 'pass' : 'fail');
    const icon = noData ? '⏳' : (g.passed ? '✓' : '✗');
    return '<div class="gate">' +
      '<div class="gate-icon ' + cls + '">' + icon + '</div>' +
      '<div class="gate-info"><div class="gate-name">' + g.name + '</div>' +
      '<div class="gate-detail">' + g.fmt(g.current) + '</div></div></div>';
  }).join('');
}

function renderMetrics(m) {
  const el = document.getElementById('metrics');
  const cards = [
    { label: 'Total Trades', value: m.totalTrades, cls: 'blue' },
    { label: 'Win Rate', value: fmtPct(m.winRate), cls: m.winRate >= 50 ? 'green' : 'red' },
    { label: 'Profit Factor', value: fmt(m.profitFactor), cls: m.profitFactor >= 1.25 ? 'green' : 'red' },
    { label: 'Total PnL', value: fmt(m.totalPnlSol, 4) + ' SOL', cls: pnlColor(m.totalPnlSol) },
    { label: 'Avg Win', value: '+' + fmtPct(m.avgWinPct), cls: 'green', sub: m.wins + ' wins' },
    { label: 'Avg Loss', value: fmtPct(m.avgLossPct), cls: 'red', sub: m.losses + ' losses' },
    { label: 'Max Drawdown', value: fmtPct(m.maxDrawdownPct), cls: m.maxDrawdownPct <= 10 ? 'green' : 'red' },
    { label: 'Sharpe Ratio', value: fmt(m.sharpeRatio), cls: m.sharpeRatio > 0 ? 'green' : 'red' },
    { label: 'Avg Hold Time', value: Math.round(m.avgHoldTimeMinutes) + ' min', cls: '' },
    { label: 'Uptime', value: fmt(m.uptimeHours, 1) + 'h', cls: 'blue' },
    { label: 'Exec Attempts', value: m.executionAttempts, cls: '' },
    { label: 'Exec Failures', value: m.executionFailures, cls: m.executionFailures > 0 ? 'yellow' : 'green' },
  ];
  el.innerHTML = cards.map(c =>
    '<div class="card"><h3>' + c.label + '</h3>' +
    '<div class="value ' + c.cls + '">' + c.value + '</div>' +
    (c.sub ? '<div class="sub">' + c.sub + '</div>' : '') +
    '</div>'
  ).join('');
}

function renderStatus(s) {
  const el = document.getElementById('sysStatus');
  const cards = [
    { label: 'Equity', value: fmt(s.portfolio.equitySol, 4) + ' SOL', cls: 'blue' },
    { label: 'Open Positions', value: s.openPositions.length + ' / ' + s.portfolio.openPositions, cls: '' },
    { label: 'Daily PnL', value: fmtPct(s.portfolio.dailyPnlPct), cls: pnlColor(s.portfolio.dailyPnlPct) },
    { label: 'Pending Tokens', value: s.pendingCandidates, cls: '' },
    { label: 'Trade Subs', value: s.tradeSubscriptions, cls: '' },
    { label: 'Consec Losses', value: s.portfolio.consecutiveLosses, cls: s.portfolio.consecutiveLosses >= 3 ? 'yellow' : '' },
  ];
  el.innerHTML = cards.map(c =>
    '<div class="card"><h3>' + c.label + '</h3>' +
    '<div class="value ' + c.cls + '">' + c.value + '</div></div>'
  ).join('');

  // Open positions
  const posEl = document.getElementById('openPositions');
  if (s.openPositions.length === 0) {
    posEl.innerHTML = '<div class="no-data">No open positions</div>';
  } else {
    posEl.innerHTML = s.openPositions.map(p =>
      '<div class="pos-card">' +
      '<div><div class="pos-mint">' + shortMint(p.mint) + '</div>' +
      '<div class="pos-detail">Hold: ' + p.holdTimeMins + 'm | Remaining: ' + fmt(p.remainingPct,0) + '%' +
      (p.tp1Hit ? ' | TP1 ✓' : '') + (p.tp2Hit ? ' | TP2 ✓' : '') + '</div></div>' +
      '<div class="pos-pnl ' + pnlColor(p.pnlPct) + '">' + (p.pnlPct >= 0 ? '+' : '') + fmtPct(p.pnlPct) + '</div>' +
      '</div>'
    ).join('');
  }
}

function renderTrades(trades) {
  const el = document.getElementById('tradeTable');
  document.getElementById('tradeCount').textContent = trades.length + ' trades';

  if (trades.length === 0) {
    el.innerHTML = '<tr><td colspan="6" class="no-data">No trades yet</td></tr>';
    return;
  }

  // Most recent first
  const sorted = [...trades].reverse();
  el.innerHTML = sorted.map(t => {
    const isWin = t.pnlSol > 0;
    return '<tr>' +
      '<td>' + fmtDate(t.exitTime) + '</td>' +
      '<td><a class="mint-link" href="https://solscan.io/token/' + t.mint + '" target="_blank">' + shortMint(t.mint) + '</a></td>' +
      '<td class="' + pnlColor(t.pnlSol) + '">' + (t.pnlSol >= 0 ? '+' : '') + fmt(t.pnlSol, 4) + '</td>' +
      '<td><span class="badge ' + (isWin ? 'win' : 'loss') + '">' + (t.pnlPct >= 0 ? '+' : '') + fmtPct(t.pnlPct) + '</span></td>' +
      '<td>' + Math.round(t.holdTimeMinutes) + 'm</td>' +
      '<td>' + t.exitType + '</td>' +
      '</tr>';
  }).join('');
}

function renderEquityCurve(curve) {
  const canvas = document.getElementById('equityChart');
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

  if (curve.length < 2) {
    ctx.fillStyle = '#484f58';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Need at least 2 trades for chart', w/2, h/2);
    return;
  }

  const pnls = curve.map(c => c.pnl);
  const minPnl = Math.min(0, ...pnls);
  const maxPnl = Math.max(0, ...pnls);
  const range = maxPnl - minPnl || 1;
  const pad = 30;

  // Zero line
  const zeroY = pad + (h - 2*pad) * (1 - (0 - minPnl) / range);
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Y axis labels
  ctx.fillStyle = '#6e7681';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(fmt(maxPnl, 3), pad - 4, pad + 4);
  ctx.fillText(fmt(minPnl, 3), pad - 4, h - pad + 4);
  ctx.fillText('0', pad - 4, zeroY + 4);

  // Line
  ctx.beginPath();
  const stepX = (w - pad) / (curve.length - 1);
  for (let i = 0; i < curve.length; i++) {
    const x = pad + i * stepX;
    const y = pad + (h - 2*pad) * (1 - (curve[i].pnl - minPnl) / range);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const lastPnl = curve[curve.length-1].pnl;
  ctx.strokeStyle = lastPnl >= 0 ? '#3fb950' : '#f85149';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill under curve
  const lastX = pad + (curve.length - 1) * stepX;
  ctx.lineTo(lastX, zeroY);
  ctx.lineTo(pad, zeroY);
  ctx.closePath();
  ctx.fillStyle = lastPnl >= 0 ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)';
  ctx.fill();
}

function renderExitDist(dist) {
  const el = document.getElementById('exitDist');
  const entries = Object.entries(dist);
  if (entries.length === 0) {
    el.innerHTML = '<div class="no-data">No trades yet</div>';
    return;
  }

  const total = entries.reduce((s, [,v]) => s + v, 0);
  const bar = entries.map(([type, count]) => {
    const pct = (count / total) * 100;
    const color = EXIT_COLORS[type] || '#6e7681';
    return '<div class="exit-seg" style="width:' + pct + '%;background:' + color + '" title="' + type + ': ' + count + '"></div>';
  }).join('');

  const legend = entries.map(([type, count]) => {
    const pct = ((count / total) * 100).toFixed(0);
    const color = EXIT_COLORS[type] || '#6e7681';
    return '<div style="display:flex;align-items:center;gap:6px;font-size:0.8rem;">' +
      '<div style="width:10px;height:10px;border-radius:2px;background:' + color + '"></div>' +
      '<span>' + type + '</span><span style="color:#6e7681">' + count + ' (' + pct + '%)</span></div>';
  }).join('');

  el.innerHTML = '<div class="exit-bar">' + bar + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">' + legend + '</div>';
}

// Initial fetch + auto-refresh
fetchAll();
setInterval(fetchAll, 30000);
</script>
</body>
</html>`;
}
