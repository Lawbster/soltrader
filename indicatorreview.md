# Indicator Review

## Purpose

This file is a build brief for the next strategy expansion pass.

Current conclusion:

- The project is not short on raw indicators.
- The project is short on:
  - continuation templates
  - volatility-state filters
  - relative-strength filters
  - tighter template-to-market-state mapping

The next step is not "add more RSI variants". It is to add a small number of differentiated templates plus the supporting context they need.

## Current Surface

Indicators already available in backtest/live:

- `rsi`
- `rsiShort`
- `connorsRsi`
- `sma`
- `ema`
- `macd`
- `bollingerBands`
- `atr`
- `adx`
- `vwapProxy`
- `obvProxy`
- `volumeZScore`
- `atrPctRank`

Template families already available:

- mean reversion:
  - `rsi`
  - `crsi`
  - `bb-rsi`
  - `rsi-crsi-confluence`
  - `bb-rsi-crsi-reversal`
  - `vwap-rsi-range-revert`
  - `rsi2-micro-range`
- trend / pullback:
  - `trend-pullback-rsi`
  - `connors-sma50-pullback`
  - `vwap-trend-pullback`
  - `adx-trend-rsi-pullback`
- breakout:
  - `bb-squeeze-breakout`
  - `atr-breakout-follow`
- confirmation / hybrid:
  - `macd-zero-rsi-confirm`
  - `macd-signal-obv-confirm`
  - `rsi-crsi-midpoint-exit`
- regime / time gating:
  - `rsi-session-gate`
  - `crsi-session-gate`
- volatility / event filters:
  - `volume-spike-reversal`
  - `atr-percentile-entry`
  - ATR variants of some templates

## Main Gap

The current catalog is still biased toward mean-reversion entries.

That causes two recurring problems:

1. In weak or drifting markets, the bot produces many small exits and occasional outsized losers.
2. The system does not separate:
   - quiet range environments
   - trend continuation environments
   - volatility expansion environments

So the next strategy work should emphasize:

- continuation entries
- low-volatility gating for mean reversion
- breakout confirmation with volume
- relative strength vs SOL

## What To Add Next

## A. `adx-vwap-trend-continue`

### Goal

Add a clean continuation template that buys pullbacks inside a valid trend instead of buying generalized weakness.

### Why

Current templates overrepresent:

- "RSI low"
- "CRSI low"
- "price below VWAP"

There is very little:

- "trend intact"
- "pullback is shallow"
- "resume trend"

This template fills that gap.

### Logic

Buy:

- `adx > adxMin`
- `close > vwapProxy`
- optional trend alignment:
  - `ema12 > ema26`
- `rsi` pulled back into a controlled range:
  - `rsi <= rsiEntryMax`
  - `rsi >= rsiEntryMin`

Sell:

- `close < vwapProxy`
- or `rsi > rsiExit`
- or protection / SL / TP

### Required indicators

- `adx`
- `vwapProxy`
- `rsi`
- optional `ema`

### Suggested params

- `adxMin`: `[18, 20, 25, 30]`
- `rsiEntryMin`: `[35, 40]`
- `rsiEntryMax`: `[45, 50, 55]`
- `rsiExit`: `[60, 65, 70]`
- `sl`: `[-2, -3, -5]`
- `tp`: `[3, 4, 6]`

Keep the grid modest. The template should not explode daily sweep time.

### Files to change

- `src/strategy/templates/types.ts`
  - add new `TemplateId`
- `src/strategy/templates/catalog.ts`
  - add evaluator and metadata
- `src/backtest/sweep.ts`
  - add sweep definition and param grid

## B. `bb-squeeze-volume-breakout`

### Goal

Upgrade the existing breakout logic by requiring actual volume participation on the breakout.

### Why

`bb-squeeze-breakout` is useful but too permissive.

Adding `volumeZScore` should reduce false squeezes that expand briefly and then fail.

### Logic

Buy:

- previous BB width below threshold
- current BB width expanding
- `close > bollingerBands.upper`
- `volumeZScore > volZScoreMin`
- optional:
  - `adx > adxMin`

Sell:

- `close < bollingerBands.middle`
- or momentum deterioration

### Required indicators

- `bollingerBands`
- `volumeZScore`
- optional `adx`

### Suggested params

- `widthThreshold`: `[0.04, 0.05, 0.06, 0.08]`
- `volZScoreMin`: `[1.0, 1.5, 2.0]`
- optional `adxMin`: `[15, 20, 25]`
- `sl`: `[-1.5, -2, -3]`
- `tp`: `[3, 4, 6]`

### Files to change

- `src/strategy/templates/types.ts`
- `src/strategy/templates/catalog.ts`
- `src/backtest/sweep.ts`

## C. `atr-lowvol-meanrevert`

### Goal

Keep mean-reversion entries out of volatility expansion conditions.

### Why

A large fraction of current false entries come from applying mean-reversion logic when volatility is already elevated.

You already have `atrPctRank`. Use it directly.

### Logic

Buy:

- `atrPctRank < atrPctMax`
- optional `adx < adxMax`
- `rsi < rsiEntry`
  or `connorsRsi < crsiEntry`

Sell:

- `rsi > rsiExit`
- or `atrPctRank > atrPctExit`
- or price-based protection

### Required indicators

- `atrPctRank`
- `rsi` or `connorsRsi`
- optional `adx`

### Suggested params

- `atrPctMax`: `[20, 25, 30, 35]`
- `atrPctExit`: `[45, 50, 60]`
- `rsiEntry`: `[20, 25, 30]`
- `rsiExit`: `[55, 60, 65]`
- optional `adxMax`: `[20, 25, 30]`
- `sl`: `[-2, -3, -5]`
- `tp`: `[2, 3, 4]`

### Files to change

- `src/strategy/templates/types.ts`
- `src/strategy/templates/catalog.ts`
- `src/backtest/sweep.ts`

## D. `macd-vwap-pullback`

### Goal

Add a trend continuation template that uses momentum state plus pullback location, rather than waiting for a zero-cross entry only.

### Why

`macd-zero-rsi-confirm` is useful but still fairly event-driven.

This new family should express:

- trend already positive
- price still above VWAP
- momentum cooled enough to buy a pullback

### Logic

Buy:

- `macd.histogram > 0`
- `close > vwapProxy`
- `rsi < rsiEntry`
- optional:
  - previous histogram was larger and current one cooled but stayed positive

Sell:

- `macd.histogram < 0`
- or `close < vwapProxy`
- or `rsi > rsiExit`

### Required indicators

- `macd`
- `vwapProxy`
- `rsi`

### Suggested params

- `rsiEntry`: `[35, 40, 45, 50]`
- `rsiExit`: `[60, 65, 70]`
- `sl`: `[-2, -3, -5]`
- `tp`: `[3, 4, 6]`

### Files to change

- `src/strategy/templates/types.ts`
- `src/strategy/templates/catalog.ts`
- `src/backtest/sweep.ts`

## E. `connors-volume-exhaustion`

### Goal

Capture panic flush reversals more cleanly than plain CRSI.

### Why

Current CRSI families do not explicitly ask whether the move was an exhaustion event.

You already have the ingredients:

- `connorsRsi`
- `volumeZScore`
- OHLC for wick ratio

### Logic

Buy:

- `connorsRsi < crsiEntry`
- `volumeZScore > volZScoreMin`
- lower wick ratio above threshold
- optional candle close above open

Sell:

- `connorsRsi > crsiExit`
- or `close >= bollinger middle`
- or `close >= vwapProxy`

### Required indicators

- `connorsRsi`
- `volumeZScore`
- optional `bollingerBands`
- candle `open/high/low/close`

### Suggested params

- `crsiEntry`: `[5, 10, 15]`
- `crsiExit`: `[60, 70, 80]`
- `volZScoreMin`: `[1.0, 1.5, 2.0]`
- `wickMin`: `[0.4, 0.5, 0.6]`
- `sl`: `[-2, -3, -5]`
- `tp`: `[2, 3, 4, 6]`

### Files to change

- `src/strategy/templates/types.ts`
- `src/strategy/templates/catalog.ts`
- `src/backtest/sweep.ts`

## Supporting Features To Add

These are more important than adding yet another RSI flavor.

## 1. Relative strength vs SOL

### Why

The backtest already computes relative-return context in sweep output, but templates cannot use it.

That is a missed edge.

Continuation templates should strongly prefer tokens outperforming SOL.
Some reversal templates should reject tokens massively underperforming SOL.

### Add

Extend indicator/template context with:

- `relRet6hVsSolPct`
- `relRet24hVsSolPct`
- optional:
  - `solTrendRegime`

### Files to change

- `src/backtest/types.ts`
  - extend `IndicatorValues` or context structure
- `src/analysis/types.ts`
  - live snapshot support if needed
- `src/analysis/indicators.ts`
  - compute live rel-strength context
- `src/backtest/sweep.ts`
  - inject rel-strength values into strategy context
- `src/strategy/templates/catalog.ts`
  - allow templates to use them

### Suggested usage

- continuation:
  - require `relRet24hVsSolPct > 0`
- risk-off reversion:
  - reject when `relRet24hVsSolPct << 0`

## 2. Weekday/session-aware gating

### Why

You already capture hour/day context in sweep output.
The template engine only uses hour-based sessions.

That leaves edge on the table.

### Add

Support params like:

- `weekdayMask`
- `weekdayStart`
- `weekdayEnd`

Do not overbuild this. Start with:

- `allowedWeekdays?: number[]`

### Files to change

- `src/strategy/templates/types.ts`
  - add weekday to live template context
- `src/backtest/sweep.ts`
  - pass day-of-week into context adapter
- `src/strategy/templates/catalog.ts`
  - let session-gated families use weekday filters
- `src/strategy/rules.ts`
  - live path already has timestamp; pass weekday through

## 3. Market-state master filter

### Why

Templates should not be triggered just because a local token condition is true.

They should first ask:

- is this a range?
- is this a trend?
- is this an expansion?

### Add

A lightweight market-state classification from existing fields:

- range:
  - low `adx`
  - low `atrPctRank`
- trend:
  - high `adx`
  - directional VWAP / EMA bias
- expansion:
  - rising `atrPctRank`
  - BB width breakout

This can be implemented first as:

- backtest/sweep context columns
- then as template-level filters

No need for a full extra subsystem first.

## What Not To Add Right Now

## 1. More plain RSI templates

The catalog already has enough close variants.
Another simple RSI threshold template will mostly create more search noise.

## 2. Huge multi-indicator soup templates

If a strategy needs 5-6 conditions to survive, it is probably overfit.

Prefer:

- 2-3 signals
- one clear market-state assumption

## 3. More 15m-only templates without gating

15m can work, but the sample count is sparse and fragile.
Do not add more 15m families unless they express a distinct edge:

- breakout continuation
- confirmed trend pullback
- volatility expansion

## Sweep Runtime Discipline

If all of the above are added, trim routine sweep breadth so runtime stays under control.

Recommended approach:

1. Keep the existing strong families in the main set.
2. Move dead or low-information families out of daily full sweep.
3. Add a separate experimental template set for the new templates.

Candidates to demote from routine daily sweep if runtime becomes an issue:

- weak legacy `trend-pullback-rsi`
- weak legacy `vwap-rsi-reclaim`
- low-value overlapping RSI variants

Do not demote before validating that the new families actually replace them.

## Suggested Delivery Order

## Phase 1

Add the three highest-value templates:

1. `adx-vwap-trend-continue`
2. `bb-squeeze-volume-breakout`
3. `atr-lowvol-meanrevert`

Why:

- they use existing indicators
- they attack three different weaknesses
- they do not require structural data work first

## Phase 2

Add:

4. `macd-vwap-pullback`
5. `connors-volume-exhaustion`

Why:

- still useful
- slightly more niche
- better after Phase 1 results are known

## Phase 3

Add context features:

6. relative strength vs SOL
7. weekday-aware gating
8. lightweight market-state master filter

Why:

- these improve several templates at once
- they are not just single-family additions

## Acceptance Criteria

For each new template family:

1. Added to `TemplateId`
2. Added to catalog metadata and param validation
3. Added to sweep with bounded param grid
4. Included in `liveCompatible` path
5. Covered by at least one unit test or smoke test
6. Produces output rows in `npm run sweep`
7. Can be promoted into live map without extra one-off plumbing

For feature work:

1. Relative-strength fields available in both live and backtest contexts
2. Session/day filters available in both live and backtest contexts
3. At least one continuation and one mean-reversion family explicitly uses those fields

## Recommendation

Implement all of Phase 1 first.

That is the highest-value path with the current repo state:

- it broadens edge shape
- it reduces dependence on pure mean reversion
- it uses indicators you already compute
- it does not require invasive architecture work first
