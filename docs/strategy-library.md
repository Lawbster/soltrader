# Sol-Trader Strategy Library
_Last updated: 2026-03-12_

## Context

Crypto bot trading small-cap Solana tokens (PIPPIN, PUMP, HNT, POPCAT, BONK, SOL, cbBTC, TRUMP).
- Equity basket: ~100–200 USDC deployed per position, 8 tokens
- Timeframes: 1m, 5m, 15m candles (OHLCV from Birdeye / Jupiter feed)
- Regime detection: 1h rolling trend classifier per token (`uptrend` / `sideways` / `downtrend`)
- Exit engine: indicator signal + ATR trailing stop + profit lock + stale-hold timeout
- Backtesting: sweep from 2026-02-18 → present (22+ days), walk-forward robustness windows (3d/5d, step 2d)
- Key metric: `worstPnlPct > 0` across all robustness windows = real edge, not curve-fit

## CSV Schema (backtest sweep output)

`template, token, timeframe, exitParity, params, trades, winRate, pnlPct, profitFactor, sharpeRatio, maxDrawdownPct, avgWinPct, avgLossPct, avgHoldMinutes, tradesPerDay, trendRegime, entryTrendRegime, entrySignalCount, ...`

- `exitParity`: `indicator` (template drives exit) or `price` (SL/TP only)
- `trendRegime`: regime at end of backtest window
- `entryTrendRegime`: regime at entry time — more reliable for regime analysis
- `entrySignalCount`: how many times the entry condition fired (signals vs executed trades)

---

## Templates in Library (24 total)

### Group 1 — Pure Mean-Reversion / Oversold Bounce
Buys oversold dips, exits when recovered. Works in sideways + shallow downtrends.

| Template | Entry | Exit | Best regime |
|---|---|---|---|
| `rsi` | RSI < threshold | RSI > threshold | Sideways / down |
| `crsi` | ConnorsRSI < threshold | ConnorsRSI > threshold | Sideways / down |
| `bb-rsi` | Close ≤ lower BB AND RSI oversold | RSI exit OR upper BB | Sideways |
| `rsi-crsi-confluence` | RSI AND ConnorsRSI both oversold | Either exits | Sideways |
| `rsi-crsi-midpoint-exit` | RSI AND ConnorsRSI oversold | RSI crosses 50 (midpoint) | Sideways |
| `bb-rsi-crsi-reversal` | Lower BB touch AND RSI AND CRSI oversold | BB middle OR RSI exit | Sideways / down |
| `adx-range-rsi-bb` | ADX below cap (ranging) AND lower BB AND RSI oversold | BB middle OR RSI exit | Sideways |
| `rsi2-micro-range` | RSI(2) extreme oversold AND ADX low | RSI(2) high | Sideways / uptrend pullback |
| `vwap-rsi-range-revert` | ADX low AND close below VWAP AND RSI oversold | Close reclaims VWAP | Sideways |
| `vwap-rsi-range-revert-atr` | Same as above | ATR-based SL/TP | Sideways |
| `crsi-dip-recover` | CRSI dips below threshold THEN ticks up (momentum flip) | CRSI exit | Sideways |
| `crsi-dip-recover-atr` | Same as above | ATR SL/TP | Sideways |

### Group 2 — Trend + Pullback
Requires price above a trend anchor (SMA50 / VWAP), then buys oversold dips within the trend.

| Template | Entry | Exit | Best regime |
|---|---|---|---|
| `trend-pullback-rsi` | Price > SMA50 AND RSI oversold | RSI exit OR price drops below SMA50 | Uptrend |
| `connors-sma50-pullback` | Price > SMA50 AND ConnorsRSI oversold | ConnorsRSI exit OR price below SMA50 | Uptrend |
| `vwap-trend-pullback` | Price > VWAP AND RSI oversold | RSI exit OR close < VWAP | Uptrend / sideways |
| `vwap-rsi-reclaim` | Price reclaims VWAP from below (crossover) AND RSI below cap | RSI exit OR close drops below VWAP | Any |
| `adx-trend-rsi-pullback` | ADX strong AND EMA12 > EMA26 AND price > SMA50 AND RSI oversold | EMA cross bearish OR RSI exit | Uptrend |

### Group 3 — Momentum / Breakout
Entries on acceleration events — momentum flips, breakouts, histogram crosses.

| Template | Entry | Exit | Best regime |
|---|---|---|---|
| `bb-squeeze-breakout` | BB width was compressed (squeeze), now expanding AND close breaks above upper BB | Close drops below BB middle | Any (volatility expansion) |
| `atr-breakout-follow` | Close > prior high AND ATR expanding AND ADX above threshold | ADX weakens OR close drops below prior high | Uptrend |
| `macd-zero-rsi-confirm` | MACD histogram crosses zero from negative (zero-line cross) AND RSI below cap | Histogram goes negative OR RSI exit | Uptrend / recovery |
| `macd-signal-obv-confirm` | MACD line crosses signal line AND OBV rising | MACD cross bearish OR OBV falls | Uptrend |

### Group 4 — Session-Gated
Standard oversold entry but only active during a specific 8h UTC window. Captures session-specific liquidity patterns.

| Template | Entry | Exit | Best regime |
|---|---|---|---|
| `rsi-session-gate` | RSI oversold AND within 8h UTC session window | RSI exit | Any (session-filtered) |
| `crsi-session-gate` | ConnorsRSI oversold AND within 8h UTC session window | CRSI exit | Any (session-filtered) |

### ATR-protected variants
`rsi-atr-protect`, `vwap-rsi-range-revert-atr`, `crsi-dip-recover-atr` — same signal logic as base, SL/TP derived from ATR at entry. Rarely tested in sweep (exitParity=price covers similar ground).

---

## Current Live Deployment (2026-03-12)

| Token | Regime | Template | TF |
|---|---|---|---|
| PIPPIN | uptrend | `bb-squeeze-breakout` | 15m |
| PIPPIN | uptrend | `rsi2-micro-range` | 5m |
| PIPPIN | uptrend | `connors-sma50-pullback` | 5m |
| PIPPIN | downtrend | `bb-rsi-crsi-reversal` | 1m |
| PIPPIN | downtrend | `rsi-session-gate` | 1m |
| PIPPIN | downtrend | `bb-squeeze-breakout` | 15m |
| PIPPIN | downtrend | `rsi` | 1m |
| PUMP | sideways | `adx-range-rsi-bb` | 15m |
| PUMP | sideways | `rsi-crsi-midpoint-exit` | 15m |
| PUMP | sideways | `rsi` | 5m |
| PUMP | sideways | `bb-rsi-crsi-reversal` | 5m |
| PUMP | downtrend | `rsi` | 1m |
| HNT | sideways | `rsi-crsi-midpoint-exit` | 15m |
| HNT | sideways | `rsi-session-gate` | 1m |
| HNT | downtrend | `macd-zero-rsi-confirm` | 15m |
| HNT | downtrend | `adx-range-rsi-bb` | 1m |
| HNT | downtrend | `rsi-crsi-midpoint-exit` | 15m |
| SOL | downtrend | `crsi-session-gate` | 5m |
| SOL | downtrend | `vwap-rsi-range-revert` | 1m |
| cbBTC | sideways | `rsi-session-gate` | 1m |
| BONK | downtrend | `rsi2-micro-range` | 5m |
| BONK | downtrend | `crsi` | 1m |
| POPCAT | sideways | `rsi-session-gate` | 15m |
| POPCAT | downtrend | `connors-sma50-pullback` | 1m |
| POPCAT | downtrend | `crsi-session-gate` | 1m |
| POPCAT | downtrend | `macd-zero-rsi-confirm` | 1m |
| POPCAT | downtrend | `adx-range-rsi-bb` | 1m |

---

## Known Dead / Disabled Routes

- PIPPIN sideways: all routes disabled (rsi-crsi-confluence, bb-rsi-crsi-reversal, connors, crsi-session, atr-breakout) — PIPPIN is a trending meme token, sideways regime rules don't hold
- PIPPIN 1m adx-range uptrend: disabled — regime mismatch in live trading, -29 USDC before kill
- HNT uptrend: no routes — not enough uptrend data in sweep window
- TRUMP: fully disabled — insufficient backtest data

---

## What Templates Are NOT Covered

Indicators we compute but haven't templated as standalone strategies:
- OBV standalone (only used as confirm in `macd-signal-obv-confirm`)
- Stochastic / Williams %R / CCI / MFI
- Volume z-score as entry filter (available in candles, not used in entries)
- ATR percentile as entry filter (available in CSV, not used in entries)
- Multi-timeframe confluence (e.g. 15m regime context → 1m entry)
- Pivot points / support-resistance levels
- Wick-fill / gap-fill mean reversion
- Linear regression slope / momentum (ROC)
- Ichimoku components (cloud, kijun, tenkan)
- Funding rate / open interest (not fetched)
- Keltner / Donchian channels
- Higher-high / higher-low structure detection

---

## Research Status

- Sweep range: 2026-02-18 → 2026-03-12 (22 days, ~15 trading days equivalent)
- Robustness: 22 windows (3d + 5d at step 2d) validated, focus on `windowsSeen >= 5 AND worstPnlPct > 0`
- Key weakness found: regime brittleness — templates profitable in one regime blow up in others; solved by `worstOtherRegimePnlPct` filter in candidates pipeline
- Tokens with most active edges: PIPPIN (high volatility meme), POPCAT (downtrend), HNT (slower, mean-reverts well), PUMP (sideways bias)
- Tokens with weak coverage: SOL (large cap, less edge), cbBTC (very few signals), BONK (thin data), TRUMP (disabled)
