# Operations

## Local Commands

```bash
npm start
npm run paper
npx tsc --noEmit
npm test
```

## Research Commands

```bash
npm run sweep -- --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 5 --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 15 --cost empirical --from 2026-02-18 --exit-parity both

npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-1min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-5min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-15min.csv --top 2000 --top-per-token 300

npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 2000 --top-per-token 300
npm run robustness-report
```

## VPS Basics

Check service:

```bash
sudo systemctl status sol-trader --no-pager
systemctl show sol-trader -p ActiveEnterTimestamp -p ActiveState
```

Restart after deploy:

```bash
sudo systemctl restart sol-trader
```

Recent logs:

```bash
sudo journalctl -u sol-trader -n 200 --no-pager
sudo journalctl -u sol-trader --since "1 hour ago"
```

## Dashboard / Runtime Checks

Metrics file:

```bash
cat data/metrics.json
```

Latest signal file:

```bash
ls data/signals
```

Latest trade log file:

```bash
ls data/data/trades
```

Open position history file:

```bash
ls data/positions-*.json
```

## Data Sync

Manual pull from VPS into local repo root:

```bash
scp -r deploy@46.225.80.0:/opt/sol-trader/data/ .
```

PowerShell helper scripts:
- `scripts/pull-vps-data.ps1`
- `scripts/register-daily-data-pull-task.ps1`

## Safety Notes

- Stop the bot before running forced close scripts.
- Treat `config/live-strategy-map.v1.json` as production state.
- Use `SHADOW_TEMPLATE=1` when validating route logic without opening new trades.
- After config changes, always verify the route snapshot on the dashboard or in logs.
