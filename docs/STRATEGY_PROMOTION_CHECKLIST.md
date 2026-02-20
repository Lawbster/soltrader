# Strategy Promotion Checklist

This checklist is the promotion gate for strategy updates in `sol-trader`.
Any strategy/config/model change must pass all required gates before it goes live.

## Scope

Applies to:
- Signal logic changes
- Parameter changes (`config/strategy*.json`)
- Feature/indicator additions
- Risk sizing changes
- Model/retraining changes

Does not apply to:
- Pure logging/UI changes with no strategy behavior impact

## Promotion Flow

1. Data QA pass (clean inputs)
2. Leakage and stability checks
3. Backtest pass (net of costs)
4. Forward paper pass
5. Controlled rollout
6. Post-deploy drift monitoring

## 1) Data QA Gate (Required)

Run daily QA on clean window only:

```bash
npm run dailyqareport -- --from 2026-02-18 --to <today-utc>
```

Hard fail if any of these are true:
- Missing price/candle files for expected watchlist mints
- Parse errors or structurally invalid rows
- Non-positive price/OHLC values
- Median span coverage below 95%
- Price max gap > 120s
- Candle max gap > 600s

Warn-level (investigate before promote):
- Median span coverage below 99%
- Price gap > 45s
- Candle gap > 120s
- Execution fail rate > 10%

Required artifact:
- Save markdown + json QA report under `data/data/qa/`

## 2) Anti-Leakage and Stability Gate (Required)

Pass conditions:
- Signals use only closed candles (no partial bar values)
- No lookahead in feature creation
- No future data leakage in label windows
- Stable outputs when rerun on same dataset/config

Recommended checks:
- Add an internal `lookahead-check` mode to re-run logic with shifted windows and assert no impossible performance uplift
- Add a recursive/startup-window sensitivity check (indicator warmup robustness)

Hard fail if:
- Any detected leakage path
- Material strategy flip from minor startup-window shift without explanation

## 3) Backtest Gate (Required)

Run with realistic costs:
- Fees included
- Slippage/impact included (from your execution/trade logs)
- Enforce position limits and cooldown rules

Required segmentation:
- Train / validation / holdout split by time (no random split)
- Per-token and portfolio-level metrics
- Time-of-day bucket diagnostics

Minimum acceptance (defaults, tune later):
- Profit factor >= 1.15 on holdout
- Max drawdown <= 12% on holdout
- Positive expectancy net of fees/slippage
- No single-token dependency > 50% of total PnL

Hard fail if:
- Great in-sample, weak holdout (clear overfit signature)
- Results disappear when costs are increased modestly

## 4) Forward Paper Gate (Required)

Paper run on production-like feed/config:
- Minimum 7 days continuous
- Same watchlist, sizing logic, and risk rules intended for live
- Capture all decisions (entry/exit tags + reject reasons)

Minimum acceptance:
- Live-paper metrics within 25% of holdout backtest expectations
- Execution fail rate <= 3%
- No critical operational incidents in final 72h

Hard fail if:
- Repeated missed fills/quote failures invalidate assumptions
- Strategy behavior materially diverges from backtest without root cause

## 5) Controlled Rollout Gate (Required)

Rollout schedule:
- Phase 1: 25% target size for 3 days
- Phase 2: 50% target size for 4 days
- Phase 3: 100% only if prior phases pass

Live guardrails:
- Daily max drawdown stop
- Daily loss limit stop
- Fail-safe switch for elevated execution errors
- Cooldown after consecutive losses

Immediate rollback triggers:
- >25% performance deviation vs paper baseline over rolling 3 days
- Execution fail rate > 2x paper baseline
- Data QA failures on active trading window

## 6) Post-Deploy Monitoring (Required)

Monitor daily:
- Data quality status
- Strategy conversion funnel:
  - signals -> eligible -> orders -> fills -> closed trades
- Execution quality:
  - latency, impact, slippage drift
- Risk:
  - drawdown, streaks, exposure concentration

Weekly review:
- Refit/retrain decision
- Parameter drift decision
- Token universe changes
- Retirement decision for degrading strategies

## Artifacts Required for Sign-Off

- QA report (`.md` + `.json`)
- Backtest summary (train/val/holdout)
- Forward-paper summary
- Rollout decision log
- Current strategy config snapshot

## Sign-Off Template

- Change ID:
- Date (UTC):
- Owner:
- Strategy/config version:
- QA gate: PASS / FAIL
- Leakage/stability gate: PASS / FAIL
- Backtest gate: PASS / FAIL
- Forward paper gate: PASS / FAIL
- Rollout approved: YES / NO
- Notes:

