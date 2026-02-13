# Logging Schema & File Paths

This defines the dataset we will collect for 1‑minute pip analysis and CRSI evaluation.

## Storage Plan
Daily export + weekly archive.
- Daily files: per day, per token (candles) and per day (signals/executions)
- Weekly archive: ZIP/TAR of the last 7 days

All files live under `/opt/sol-trader/data/`.

---

## 1) Candles (CSV)
**Purpose:** primary time‑aligned dataset for analysis and backtests.  
**Interval:** 1 minute  
**File path:**
```
data/candles/<mint>/YYYY-MM-DD.csv
```

**Columns (CSV header):**
```
timestamp,open,high,low,close,volume
```

**Notes**
- `timestamp` in ms (UTC epoch).
- `volume` in token units or SOL; pick one and keep consistent (recommend SOL).

---

## 2) Signals (JSONL)
**Purpose:** record every strategy evaluation snapshot.  
**File path:**
```
data/signals/YYYY-MM-DD.jsonl
```

**Schema (per line):**
```json
{
  "ts": 0,
  "mint": "",
  "source": "price-feed|trades",
  "crsi": 0,
  "rsi": 0,
  "priceUsd": 0,
  "priceSol": 0,
  "candles": 0,
  "candlesNeeded": 0,
  "oversold": 20,
  "entryDecision": true,
  "rejectReason": "",
  "quotedImpactPct": 0,
  "liquidityUsd": 0,
  "effectiveMaxSol": 0,
  "sampleTrades": 0
}
```

**Notes**
- `entryDecision` true/false on every evaluation.
- If false, set `rejectReason`.

---

## 3) Executions (JSONL)
**Purpose:** record actual trade actions (paper or live).  
**File path:**
```
data/executions/YYYY-MM-DD.jsonl
```

**Schema (per line):**
```json
{
  "ts": 0,
  "mint": "",
  "side": "buy|sell",
  "sizeSol": 0,
  "price": 0,
  "slippageBps": 0,
  "quotedImpactPct": 0,
  "result": "success|fail",
  "error": ""
}
```

---

## 4) Daily Summary (JSON)
**Purpose:** quick aggregate metrics snapshot.  
**File path:**
```
data/summaries/YYYY-MM-DD.json
```

**Schema:**
```json
{
  "date": "YYYY-MM-DD",
  "totalTrades": 0,
  "winRate": 0,
  "profitFactor": 0,
  "maxDrawdownPct": 0,
  "avgWinLoss": 0,
  "uptimeHours": 0
}
```

---

## Daily Export (VPS → Local)
From your local machine:
```
scp -r deploy@<server-ip>:/opt/sol-trader/data/candles ./data/candles
scp deploy@<server-ip>:/opt/sol-trader/data/signals/*.jsonl ./data/signals/
scp deploy@<server-ip>:/opt/sol-trader/data/executions/*.jsonl ./data/executions/
scp deploy@<server-ip>:/opt/sol-trader/data/summaries/*.json ./data/summaries/
```

## Weekly Export (Archive)
On VPS (weekly):
```
cd /opt/sol-trader/data
tar -czf archive-YYYY-WW.tar.gz candles signals executions summaries
```
Then pull:
```
scp deploy@<server-ip>:/opt/sol-trader/data/archive-YYYY-WW.tar.gz ./archives/
```

---

## Watchlist Tokens (Current)
- POPCAT: `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr`
- PIPPIN: `Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump`
- TRUMP: `6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN`
- BONK: `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`
- PUMP: `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`
- cbBTC: `cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij`
- ETH (Wormhole): `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs`
- RAY: `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R`
- JUP: `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`
