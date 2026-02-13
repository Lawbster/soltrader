Claude changes:

New file: price-feed.ts — Stores rolling Jupiter price history per mint. recordPrice() to store, buildCloseSeriesFromPrices() to bucket into candles. Keeps 150 minutes of data (enough for 120min CRSI lookback).

Modified: indicators.ts — getIndicatorSnapshot() now checks if trade-based candles are sufficient for CRSI (needs 101+). If not, falls back to the price feed series. Logs which source is being used.

Modified: token-data.ts — Exported fetchTokenPrice() (formerly private getTokenPrice()) so the price poll can call it without the heavy RPC calls.

Modified: index.ts — Added a dedicated 30s price poll for watchlist tokens that calls fetchTokenPrice (Jupiter only, zero RPC) and records each price. Status log now shows price history counts per token.

Modified: analysis/index.ts — Barrel exports updated.

How it works now
Every 30s, the bot polls Jupiter for POPCAT's USD price (~1 HTTP call, no RPC)
Prices accumulate in the price feed (2 points per minute)
After ~51 minutes (101 one-minute candles), CRSI can start computing
The WSS trade subscription is still there as a secondary source, but the bot no longer depends on it for CRSI signals
After deploying
Watch for these in the logs:

"Price history" messages showing points accumulating
Status log showing "priceHistory":{"7GCihgDB":N} where N grows
After ~50 min: "Indicator candles" with "source":"price-feed" and candles >= 101
Eventually CRSI values appearing in analysis