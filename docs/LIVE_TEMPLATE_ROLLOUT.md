# Live Template Rollout Guide

Reference implementation: PRs 1–7 (2026-02-25)

This document describes how to safely roll out template-based live trading after the
strategy engine has been upgraded from RSI/CRSI-only to the shared template catalog.

---

## Overview of Changes

After the PR1–PR7 upgrade:

- All 21 strategy templates (rsi, crsi, vwap-rsi-range-revert, adx-range-rsi-bb, etc.) can
  be routed live via the strategy map.
- Entry signals come from `evaluateSignal(templateId, params, ctx)` in the shared catalog.
- Exit mode is explicit per regime block: `exitMode: 'price'` (SL/TP only) or `exitMode: 'indicator'`
  (template sell signal + SL/TP fallback).
- The live-strategy-map schema now supports either old RSI/CRSI format or new template format
  per regime block. Both are backward-compatible.

---

## Phase 1 — Shadow Mode (24h minimum)

Shadow mode logs all template-driven entry decisions without executing any trades.
RSI/CRSI tokens are unaffected and continue trading normally.

### Enable shadow mode

```bash
# On VPS
SHADOW_TEMPLATE=1 tsx src/index.ts
# or if running via systemd: add Environment=SHADOW_TEMPLATE=1 to the service file
```

### What to verify in logs

Every suppressed entry will log:
```
SHADOW_TEMPLATE: entry suppressed {
  mint: ..., label: ..., templateId: ..., exitMode: ..., regime: ..., sizeUsdc: ...
}
```

Check that:
- Template IDs match what you configured in `live-strategy-map.v1.json`
- `regime` values are correct (sideways/uptrend/downtrend)
- `exitMode` is `'price'` for all initial canary entries
- Signal frequency looks reasonable (not constantly triggering)

### Shadow mode limitations

- **Entry signals only:** Shadow mode suppresses NEW template-driven entry signals but does
  NOT suppress exits on already-open positions opened before shadow mode was enabled.
- **Cleanup before canary:** If testing after existing positions are open, stop the bot,
  run `scripts/close-all-positions.ts --confirm` to clear positions, then restart with
  `SHADOW_TEMPLATE=1`.

---

## Phase 2 — Canary Rollout (1–2 tokens)

After 24h shadow mode with clean signal behavior, enable 1–2 tokens in the live map.

### Recommended first canary tokens

1. **PIPPIN** — `crsi` template, already-tested RSI logic, just enabling sideways regime
2. **PUMP** — `rsi` template, well-understood behavior

These use the same RSI/CRSI logic as before (just routed through the catalog), so
behavioral parity is guaranteed.

### Enable a token for canary

In `config/live-strategy-map.v1.json`, set `enabled: true` on the specific regime block:

```json
"sideways": {
  "enabled": true,
  "templateId": "crsi",
  "params": { "entry": 10, "exit": 95 },
  "sl": -3,
  "tp": 3,
  "exitMode": "price"
}
```

The bot hot-reloads config on file change (mtime check). No restart needed.

### Canary verification checklist

- [ ] Entry fills log with `templateId` and `exitMode` fields
- [ ] Position is opened at expected size
- [ ] Exit fires on SL or TP as configured
- [ ] Dashboard signals endpoint shows `templateId` and `exitMode` for the token
- [ ] No unexpected errors in bot log for 4+ hours

### Non-RSI/CRSI template canary (e.g. vwap-rsi-range-revert)

Only add non-RSI/CRSI templates after confirming RSI/CRSI canary is clean. Suggested order:

1. `vwap-rsi-range-revert` (HNT, POPCAT) — uses ADX + RSI entry
2. `rsi-session-gate` (TRUMP) — adds UTC hour gate; keep disabled until second canary round
3. `adx-range-rsi-bb` — requires ADX; verify adxSource in indicator logs

---

## Phase 3 — Full Rollout

After successful canary on 2+ tokens over 24–48h:

1. Enable remaining watchlist tokens by regime as recommended by `build-live-map` output
2. Monitor `templateId`, `exitMode`, `regime` fields in dashboard for all active positions
3. Compare PnL behavior against backtest expectations (parity check)

---

## Rollback Procedure

### Quick rollback (disable specific token)

In `config/live-strategy-map.v1.json`, set the token's top-level `enabled: false`:
```json
"hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux": {
  "enabled": false,
  ...
}
```
Config hot-reloads. No restart needed. Existing positions continue to exit normally.

### Emergency: close all positions and stop bot

```bash
# 1. Stop the bot (prevents new entries)
systemctl stop sol-trader

# 2. Force-close all open positions
cd /opt/sol-trader
tsx scripts/close-all-positions.ts --confirm

# 3. Revert live-strategy-map.v1.json to a prior version if needed
# 4. Restart
systemctl start sol-trader
```

### Revert to RSI/CRSI-only format

The old flat params format is still supported (backward compat maintained in PR3).
You can revert individual regime blocks to the old format:
```json
"sideways": {
  "enabled": true,
  "params": { "entry": 25, "exit": 85, "sl": -3, "tp": 1 }
}
```
The parser will auto-detect the format. No code change needed.

---

## Monitoring Fields

After the PR1–PR7 upgrade, the following fields are available in logs and dashboard:

| Field | Source | Description |
|-------|--------|-------------|
| `templateId` | Entry log, dashboard | Which template produced the signal |
| `exitMode` | Entry log, position log | `'price'` or `'indicator'` |
| `regime` | Entry log | Trend regime at time of entry |
| `templateSellReason` | Exit log | `template-indicator-exit: <id>` when indicator exit fires |
| `adxSource` | Indicator log (DEBUG) | `'trades'` / `'price-feed'` / `'unavailable'` |

---

## Candidate-to-Live-Map Workflow

After each sweep run (owned by Emil):

```bash
# 1. Emil runs sweep
npm run sweep -- --cost empirical --from 2026-02-18 --exit-parity both

# 2. Generate ranked candidates
npm run sweep-candidates -- --file data/data/sweep-results/YYYY-MM-DD-1min.csv --top 300 --top-per-token 75

# 3. Generate live-map patch proposal
npm run build-live-map -- --file data/data/sweep-results/candidates/YYYY-MM-DD-1min.core-ranked.csv

# 4. Review patch output, copy promoted regime blocks into live-strategy-map.v1.json
# 5. Start with shadow mode, then canary, then full rollout
```
