# Go-Live Gates Checklist

Before switching from paper trading to live execution, ALL gates must pass.

## Minimum Data Requirements

- [ ] **Minimum 120 simulated trades** completed
- [ ] **Minimum 14 days** of continuous paper trading
- [ ] Paper trading ran on the same strategy config that will be used live

## Performance Gates

| Metric | Threshold | Current | Pass? |
|--------|-----------|---------|-------|
| Profit Factor | >= 1.25 | ___ | [ ] |
| Win Rate | >= 50% | ___ | [ ] |
| Avg Win / Avg Loss | >= 1.35 | ___ | [ ] |
| Max Drawdown | <= 10% | ___ | [ ] |
| Sharpe Ratio | > 0 | ___ | [ ] |

## Operational Gates

| Metric | Threshold | Current | Pass? |
|--------|-----------|---------|-------|
| Strategy Uptime | >= 99% | ___ | [ ] |
| Execution Failure Rate | <= 3% | ___ | [ ] |
| No critical bugs in last 48h | Yes | ___ | [ ] |

## Infrastructure Gates

- [ ] VPS provisioned and running (Hetzner/Contabo, Ubuntu)
- [ ] Bot runs stable on VPS for >= 48h without manual intervention
- [ ] WALLET_PRIVATE_KEY securely deployed (not in repo, env-only)
- [ ] Wallet funded with intended starting capital
- [ ] Discord/Telegram alerts configured and tested

## Ramp-Up Plan (after all gates pass)

| Week | Position Size | Condition |
|------|--------------|-----------|
| 1 | 0.25x of paper size | Always |
| 2 | 0.5x | Week 1 metrics within 20% of paper |
| 3+ | 1.0x | Week 2 metrics within 15% of paper |

If live metrics deviate >25% from paper at any point, pause and investigate.

## How to Check

Run `npm start` and wait for shutdown (Ctrl+C). The metrics summary prints on exit.
Or check `data/metrics.json` for the latest aggregate stats.

The `getAggregateMetrics()` function in `src/strategy/metrics.ts` returns all values needed to fill this table.

## Sign-Off

Date: ___
All gates passed: [ ] Yes / [ ] No
Notes: ___
