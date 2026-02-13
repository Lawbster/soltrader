# Strategy — POPCAT CRSI Scalper (Current)

This is the current single‑pair strategy configuration. It reflects the active bot config and is intentionally narrow.

## Universe
- Watchlist only
- Mint: `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr`
- Pool: `HBS7a3br8GMMWuqVa7VB3SMFa7xVi1tSFdoF5w4ZZ3kS`

## Entry Signal
- Connors RSI (1‑minute candles)
- Trigger: **CRSI <= 20**
- CRSI source: trade‑based candles if available, else Jupiter price‑feed fallback

## Exits (Current Config)
- Take profit: **+0.50%** (100% exit)
- Stop loss: **‑0.25%**
- TP2 and runner disabled

## Slippage Guard
- Pre‑flight Jupiter quote rejects entry if **priceImpactPct > 0.10%**
- Note: `entry.maxSlippagePct` is still 2.0 in config, which is too loose for tight pips. Tighten when ready.

## Position Sizing Controls
- Liquidity cap: **0.05% of pool liquidity**
- Max position cap: **1.25 SOL**
- Sample‑size gate: cap at **5 SOL until 200 trades**
- Equity cap: **8% of equity**

## Validation Target
- Minimum **200–400 trades** before scaling size or loosening filters.
