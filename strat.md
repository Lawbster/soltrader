# Live Strategy — sol-trader

**Mode**: Watchlist-only RSI mean-reversion
**Universe**: 8 fixed tokens (no launch sniping)
**Candles**: 1-minute intervals, 120-candle lookback
**Indicator**: RSI(14) — enter on oversold, exit at fixed SL or TP

---

## Token Basket

| Token  | Tier  | Max Size | Entry (RSI <) | Stop Loss | Take Profit |
|--------|-------|----------|----------------|-----------|-------------|
| PIPPIN | core  | $15      | 35             | -5%       | +1%         |
| PUMP   | probe | $12      | 25             | -5%       | +1%         |
| HNT    | probe | $12      | 20             | -5%       | +1%         |
| SOL    | probe | $10      | 20             | -3%       | +2%         |
| cbBTC  | probe | $7.50    | 40             | -3%       | +1%         |
| BONK   | probe | $7.50    | 25             | -2%       | +1%         |
| TRUMP  | probe | $5       | 15             | -5%       | +1%         |
| POPCAT | probe | $5       | 20             | -5%       | +2%         |

Max total deployed: ~$74 across all 8 if every token triggers simultaneously (unlikely).

---

## Entry Logic

1. RSI(14) computed on 1-minute candles (120-candle window)
2. Enter when `RSI < entry threshold` for that token
3. Per-token position cap applied: `min(calculatePositionSize(equity), maxPositionUsdc)`
4. Global score filter still runs (currently `minScoreToTrade: 0`, effectively off)
5. Portfolio gates: max 3 concurrent positions, max 20% open exposure
6. Re-entry lockout: 4 minutes per token after close

---

## Exit Logic

Exits are evaluated every ~15 seconds on each open position.

| Condition              | Action          |
|------------------------|-----------------|
| PnL ≤ SL%              | Sell 100%, close |
| PnL ≥ TP%              | Sell 100%, close |
| Emergency LP drop      | Disabled (-999%) |

No partial exits, no trailing stops, no time-based stops for per-token positions.
Exit type logged as `hard_stop` (SL) or `tp1` (TP).

---

## Portfolio Config

| Setting                  | Value       |
|--------------------------|-------------|
| Max concurrent positions | 3           |
| Max open exposure        | 20% equity  |
| Daily loss limit         | -8%         |
| Re-entry lockout         | 4 min       |
| Paper trading            | false (LIVE)|

---

## Sweep Origins

Params derived from backtests on 6 months of price history (sweep-candidates.ts).
Best RSI(14) entry/exit/SL/TP combos selected per token by win rate × avg return.

| Token  | Backtest WR | Trades (sample) |
|--------|-------------|-----------------|
| PIPPIN | 92%         | 38              |
| PUMP   | 100%        | 7               |
| HNT    | 100%        | 4               |
| SOL    | 67%         | 6               |
| cbBTC  | 71%         | 7               |
| BONK   | 100%        | 5               |
| TRUMP  | 100%        | 3               |
| POPCAT | 75%         | 4               |

⚠️ Small sample sizes — treat WR as directional, not proven.

---

## Known Limitations

- `fetchPoolLiquidity` gives unreliable estimates for large-cap tokens (0% price impact floor = $1M). LP drop filter disabled for watchlist tokens as a result.
- PUMP, cbBTC occasionally show `liquidityUsd: 1_000_000` (fallback) — doesn't block entries.
- Re-entry lockout is short (4 min) — could re-enter same token multiple times in a session.
