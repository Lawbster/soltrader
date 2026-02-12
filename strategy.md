# Strategy v1: Solana Microcap Momentum With Risk-Off Filters

## Goal
Implement a real, testable scalp strategy for Solana microcaps with strict risk controls and measurable go-live gates.

## 1) Tradable Universe
- Sources: pump.fun launches and Raydium new pairs.
- Token age: 60 to 360 minutes.
- Market cap: $20k to $120k.
- Liquidity: at least $15k in pool.
- 5-minute volume: at least $8k.
- Exclude if mint/freeze authority is not renounced (or equivalent high-risk flag).
- Exclude if top-10 holders own more than 35% (excluding LP/burn/system wallets).

## 2) Entry Signal (All Conditions Required)
- Momentum: 1-minute close above VWAP and 5-minute return at least +6%.
- Participation: 5-minute buy volume / sell volume at least 1.4.
- Flow quality: at least 25 unique buyers in 5 minutes, and no single wallet contributes more than 12% of buys.
- Liquidity stability: LP change over last 10 minutes is greater than -15%.
- Execution guard: Jupiter expected slippage at target size is at most 2.0%.

## 3) Entry Scoring (Ranking)
Use scoring only after all hard filters pass.

Score weights:
- 30% momentum strength (1m and 5m returns)
- 25% buy/sell pressure
- 20% holder distribution quality
- 15% liquidity depth and stability
- 10% wallet concentration risk (penalty component)

Minimum score to trade: 70/100.

## 4) Position Sizing
- Risk per trade: 0.75% of wallet equity.
- Max position cap: min(1.25 SOL, 8% of wallet equity).
- Sizing formula: position_notional = risk_per_trade / stop_distance.
- Initial stop distance: 9% from entry.

## 5) Exits
- Hard stop: -9%.
- TP1: +12%, sell 50%, move stop to breakeven plus fees.
- TP2: +22%, sell 30%.
- Runner: hold last 20% with 6% trailing stop from local high.
- Time stop: close full position after 20 minutes if PnL is between -3% and +6%.
- Emergency exit: close if liquidity drops more than 25% in 3 minutes or abnormal sell wall appears.

## 6) Portfolio Risk Limits
- Max concurrent positions: 3.
- Max total open exposure: 20% of wallet.
- Daily loss limit: -4% equity, then stop trading for the day.
- Consecutive loss limit: 4 losses, then 2-hour cooldown.
- Re-entry lockout: after stop-out, do not re-enter same token for 12 hours.

## 7) Execution Rules (Live)
- Route all orders through Jupiter and verify route depth.
- Reject if route impact is greater than 2.5%.
- Reject if transaction simulation fails.
- Use priority fees and Jito bundle support for inclusion speed.
- Retry at most 2 times, then fail-safe alert.
- Log each trade with: quote price, expected slippage, actual fill, tx latency, fees.

## 8) Paper Trading Realism Requirements
Paper mode must simulate:
- quote-to-send latency (300 to 1200 ms)
- slippage from pool depth
- transaction failure probability
- priority fee costs

Do not use perfect-fill assumptions.

## 9) Go-Live Gates (All Required Over 14 Days Paper)
- At least 120 simulated trades.
- Profit factor at least 1.25.
- Win rate at least 50%.
- Avg win / avg loss at least 1.35.
- Max drawdown at most 10%.
- Strategy uptime at least 99%.
- Execution failure rate at most 3%.

## 10) Live Rollout Plan
- Week 1: 0.25x normal size.
- Week 2: 0.5x size if metrics remain within gates.
- Week 3 and onward: 1.0x size only if live performance remains within 15% of paper metrics.

## 11) Required Implementation Artifacts
- config/strategy.v1.json for all thresholds and limits.
- src/strategy/rules.ts for entry/exit/risk checks.
- src/strategy/scoring.ts for score computation.
- src/execution/guards.ts for route/slippage/kill-switch checks.
- docs/LIVE_GATES.md for pass/fail decision checklist.
