# How To Test Paper Trading (Going Forward)

This guide is the operational playbook for running `sol-trader` in paper mode, collecting reliable data, and deciding if it is ready for live rollout.

## 1) Pre-Flight Checklist

Before each long run:

1. Confirm dependencies and type safety:
```powershell
npm install
npm run build
npm test
```
2. Confirm paper mode is enabled in `.env`:
- `PAPER_TRADING=true`
3. Confirm RPC/WSS values are valid in `.env`:
- `HELIUS_RPC_URL`
- `HELIUS_WSS_URL`
- `HELIUS_API_KEY`
4. Optional dashboard port:
- `DASHBOARD_PORT=3847` (default)

## 2) Start a Paper Session

Run the bot:
```powershell
npm start
```

What starts automatically:
- Token monitor (pump.fun + Raydium)
- Strategy analysis loop
- Position management loop
- Metrics persistence
- Dashboard server at `http://localhost:3847`

## 3) What To Watch During Runtime

### Dashboard
Open: `http://localhost:3847`

Key areas:
- Go-live gate progress
- Win rate / profit factor / drawdown / Sharpe
- Open positions and exits
- Execution failure rate

### API endpoints (optional)
- `GET /api/metrics`
- `GET /api/trades`
- `GET /api/gates`
- `GET /api/status`
- `GET /api/equity-curve`

### Files written in `data/`
- `data/metrics.json` (aggregate + per-trade stats)
- `data/positions-YYYY-MM-DD.json`
- `data/snapshots-YYYY-MM-DD.json`

## 4) Daily Operating Routine (Recommended)

1. Keep one continuous process running as long as possible.
2. Once per day, capture a checkpoint:
- trades count
- win rate
- profit factor
- max drawdown
- execution failure rate
3. If bot restarts, verify `data/metrics.json` reload happened (check logs).
4. Keep config stable during the 14-day window (avoid threshold changes mid-sample).

## 5) Local PC Testing Guidance

You can test from your home PC, but treat it as a dry run environment.

Risks on local machine:
- Sleep/hibernate interrupts feed + trading loops.
- Home internet outages create gaps in sample quality.
- Reboots/updates reduce uptime metric reliability.

Recommendations:
1. Disable sleep during test window.
2. Keep terminal open and monitor logs.
3. Avoid heavy workloads while bot is running.
4. If possible, move the 14-day validation run to a VPS for cleaner uptime data.

## 6) Stop Safely

Use `Ctrl+C`.

On shutdown, the bot persists:
- snapshots
- position history
- metrics
- summary metrics in logs

Do not force-kill unless needed.

## 7) Pass/Fail Decision After 14 Days

Use `docs/LIVE_GATES.md` as source of truth.

Minimum sample requirements:
- at least 120 paper trades
- at least 14 days runtime

Core gates to pass:
- Profit Factor >= 1.25
- Win Rate >= 50%
- Avg Win / Avg Loss >= 1.35
- Max Drawdown <= 10%
- Execution Failure Rate <= 3%

If gates fail:
1. Keep paper mode on.
2. Adjust one parameter group at a time.
3. Re-run a fresh measurement window.

## 8) Common Troubleshooting

### No trades happening
- Check monitor is receiving launches.
- Check filters are not too strict for current market regime.
- Check RPC/WSS connectivity.

### High execution failures in paper mode
- Review simulated failure rate in strategy config.
- Confirm quote endpoints are reachable.

### Dashboard not loading
- Confirm process is running.
- Confirm `DASHBOARD_PORT` and local firewall.
- Try `http://localhost:3847/api/status`.

## 9) Suggested Next Step After Local Validation

When local run is stable, repeat the same workflow on a VPS for a cleaner 14-day sample before any live capital.
