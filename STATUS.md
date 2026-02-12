# Sol-Trader: Project Status & Design Reference

Last updated: 2026-02-11

## Completed Phases

### Phase 1: Data & Monitoring ✅
- Helius WebSocket subscriptions to pump.fun + Raydium AMM programs
- Token launch detection via `onLogs` — parses create/initialize instructions
- Raydium launches enriched via `getParsedTransaction` for mint extraction
- Snapshot store: periodic token data collection to `data/snapshots-YYYY-MM-DD.json`
- Core utils: config loader (.env), structured JSON logger, wallet (bs58 keypair), RPC singleton

### Phase 2: Analysis & Filtering ✅
- **Token data fetcher** (`src/analysis/token-data.ts`): Jupiter price API for price/mcap, RPC for mint authority + freeze authority status, holder distribution from `getTokenLargestAccounts` with LP/burn/system wallet exclusion. **Token age now from on-chain mint creation time** (walks `getSignaturesForAddress` to find creation tx, cached)
- **Trade tracker** (`src/analysis/trade-tracker.ts`): Per-token WebSocket subscriptions detect swaps, then async-enrich each via `getParsedTransaction` for real wallet/price/amount. Rolling 30-min trade history. Computes: buy/sell ratio, unique buyers, VWAP, 5m return, whale concentration. **Dedup uses two-generation bounded set** (2500 per generation, auto-rotates)
- **Liquidity estimation**: Jupiter quote impact method (1 SOL probe → estimate pool depth)
- **Hard filters** (`src/analysis/token-filter.ts`): Token age 60-360min, mcap $20k-$120k, liquidity ≥$15k, 5m volume ≥$8k, authority renounced, top10 holders ≤35%, 5m return ≥6%, B/S ratio ≥1.4, unique buyers ≥25, single wallet ≤12% of buys, LP change ≥-15% in 10min
- **Scoring** (`src/strategy/scoring.ts`): 5-component weighted score (momentum 30%, B/S pressure 25%, holder distribution 20%, liquidity 15%, wallet concentration 10%). Min score 70/100 to trade
- **Entry/exit rules** (`src/strategy/rules.ts`): Full entry evaluation (portfolio limits → filters → score → position size). Exit logic: hard stop -9%, TP1 +12% sell 50%, TP2 +22% sell 30%, runner 20% with 6% trailing, time stop 20min, emergency LP drop
- **Strategy config** (`config/strategy.v1.json`): All thresholds externalized and tunable

### Phase 3: Execution Engine ✅
- **Jupiter swap** (`src/execution/jupiter-swap.ts`): Quote → simulate → sign → send → confirm → verify fill from on-chain balance deltas. Retry up to 2x. Proper unit normalization: `solAmount` (human), `tokenAmount` (decimal-adjusted), `tokenAmountRaw` (for sell calls). Token decimals cached. Dead code removed (unused preBalanceLamports)
- **Jito bundles** (`src/execution/jito-bundle.ts`): **Builds separate tip tx and bundles [swap, tip] atomically** via Jito block engine. Random tip account selection. Standard RPC fallback always sent in parallel
- **Execution guards** (`src/execution/guards.ts`): Route impact ≤2.5%, slippage validation, tx simulation check, kill switch (daily loss + consecutive losses)
- **Position manager** (`src/execution/position-manager.ts`): Full lifecycle — open (all portfolio checks), update every 5s (price refresh + exit eval), partial sells (TP1/TP2/runner), trailing stop tracking, daily P&L with unrealized PnL in equity, consecutive loss counter, re-entry lockout 12h, position history to JSON. **Failed full-exits do NOT close positions** (return early for retry). Routes through paper executor when `PAPER_TRADING=true`. Records execution attempts and closed positions to metrics

### Phase 4: Paper Trading ✅ (code complete — needs 14-day run)
- **Paper executor** (`src/execution/paper-executor.ts`): Same SwapResult interface as live. Gets real Jupiter quotes for price discovery, then applies:
  - Random latency (300-1200ms configurable)
  - Simulated slippage (0.1-1% on top of quote)
  - 5% random tx failure probability
  - Simulated priority fee deduction
- **Position manager routing**: When `PAPER_TRADING=true`, buy/sell calls go through paper executor. Position lifecycle, exit monitoring, and real price feeds work identically
- **Performance metrics** (`src/strategy/metrics.ts`): Per-trade metrics (PnL, hold time, exit type). Aggregates: win rate, avg win/loss, profit factor, max drawdown, Sharpe ratio, execution failure rate, uptime. Persisted to `data/metrics.json`. Loaded on restart. Summary printed on shutdown
- **Go-live gates** (`docs/LIVE_GATES.md`): Checklist with all thresholds and ramp-up plan
- **Test harness**: vitest with 8 safety tests (exit-close guard, unit conversions, dedup cap)

## All Review Fixes Applied

### From original review (round 1)
1. ✅ **Unit normalization** — SwapResult redesigned with explicit solAmount/tokenAmount/tokenAmountRaw
2. ✅ **Trade data empty** — Swaps enriched via getParsedTransaction (wallet, price, amount)
3. ✅ **LP change guard** — filterEntry enforces maxLpChange10mPct, LP tracked over time
4. ✅ **Subscription leak** — cleanupToken() unsubscribes + clears state, **now awaited**
5. ✅ **Holder distribution** — LP/burn/system wallets excluded by resolving token account owners
6. ✅ **Jito integration** — Wired into executeSwap with fallback
7. ✅ **Open PnL in equity** — getPortfolioState includes unrealized PnL
8. ✅ **Paper mode key** — WALLET_PRIVATE_KEY optional in paper mode, ephemeral keypair generated

### From re-audit (round 2)
1. ✅ **Critical: Failed exit closing position** — `executeExit` now returns early on failure, position stays open
2. ✅ **High: Unbounded dedup set** — Two-generation bounded set (2500/gen, auto-rotates)
3. ✅ **High: Token age from detection time** — Now fetches on-chain mint creation time via `getSignaturesForAddress`, cached, falls back to detection time
4. ✅ **Medium: Jito tip not attached** — Builds separate tip tx, bundles [swap, tip] together
5. ✅ **Medium: Async unsubscribe not awaited** — `cleanupToken` is now async, awaits unsubscribe
6. ✅ **Medium: Dead imports/vars** — Removed unused preBalanceLamports, getConnection from index.ts, createTipInstruction export
7. ✅ **Medium: No test harness** — vitest installed, `npm test` runs 8 safety tests

## Remaining Items

- **Developer wallet history check** (Phase 2) — Helius enhanced tx history to detect previous rugger wallets. Deferred — not blocking paper trading
- **Quote vs actual fill for third-party swaps** — Enrichment uses getParsedTransaction with slight delay. Accepted trade-off

## What's Next: Run Paper Trading

1. Start bot: `npm start` (PAPER_TRADING=true by default)
2. Let it run continuously for 14 days
3. Monitor `data/metrics.json` and periodic status logs
4. After 14 days, evaluate against `docs/LIVE_GATES.md` thresholds:
   - ≥120 trades, profit factor ≥1.25, win rate ≥50%, max drawdown ≤10%
5. If gates pass → Phase 5 (VPS + live trading with ramp-up)

## Architecture

```
sol-trader/
├── config/
│   └── strategy.v1.json          # All tunable thresholds
├── data/                          # Runtime: snapshots, positions, metrics (gitignored)
├── docs/
│   └── LIVE_GATES.md             # Go-live checklist
├── src/
│   ├── utils/
│   │   ├── config.ts              # .env loader, typed config
│   │   ├── logger.ts              # Structured JSON logger
│   │   ├── wallet.ts              # Keypair from base58 (optional in paper)
│   │   ├── rpc.ts                 # Helius connection singleton
│   │   └── index.ts
│   ├── monitor/
│   │   ├── types.ts               # TokenLaunch, TokenSnapshot
│   │   ├── token-monitor.ts       # WebSocket subs: pump.fun + Raydium
│   │   ├── snapshot-store.ts      # Token tracking + periodic snapshots
│   │   └── index.ts
│   ├── analysis/
│   │   ├── types.ts               # TokenData, TradeEvent, TradeWindow, etc.
│   │   ├── token-data.ts          # Price, mcap, authority, holders, on-chain age
│   │   ├── trade-tracker.ts       # Per-token swap stream + enrichment + bounded dedup
│   │   ├── token-filter.ts        # Hard filters (universe + entry + LP)
│   │   └── index.ts
│   ├── strategy/
│   │   ├── strategy-config.ts     # Typed config loader + validation
│   │   ├── scoring.ts             # 5-component weighted scoring
│   │   ├── rules.ts               # Entry/exit/portfolio risk logic
│   │   ├── metrics.ts             # Performance tracking + aggregation
│   │   └── index.ts
│   ├── execution/
│   │   ├── types.ts               # SwapQuote, SwapResult, Position, etc.
│   │   ├── guards.ts              # Route/slippage/simulation/kill-switch
│   │   ├── jupiter-swap.ts        # Jupiter v6: quote→sim→sign→send→verify
│   │   ├── jito-bundle.ts         # Jito block engine: [swap, tip] bundles
│   │   ├── paper-executor.ts      # Paper mode: real quotes + simulated execution
│   │   ├── position-manager.ts    # Full position lifecycle + paper/live routing
│   │   └── index.ts
│   └── index.ts                   # Main entry: monitor → analyze → trade → manage
├── test/
│   └── safety.test.ts             # 8 safety tests (vitest)
├── strategy.md                    # Strategy specification (from Codex)
├── review.md                      # Code review findings (from Codex)
├── PLAN.md                        # Build phases with checkboxes
├── STATUS.md                      # This file
├── package.json
├── tsconfig.json
├── .env                           # Keys (gitignored)
├── .env.example
└── .gitignore
```

## Key Design Choices

1. **All amounts are human-readable internally** — SOL in SOL, tokens in decimal-adjusted units. Raw amounts only at the Jupiter API boundary
2. **Trade data comes from parsed transactions, not log heuristics** — Every swap is enriched via `getParsedTransaction` for accurate wallet/price/amount
3. **Filters run before scoring** — Cheap hard filters eliminate 95%+ of candidates before expensive scoring
4. **Position manager is the single source of truth** for portfolio state, PnL, and risk limits
5. **Strategy config is fully externalized** in `config/strategy.v1.json` — tune without code changes
6. **Subscriptions are cleaned up** when tokens age out or positions close — no resource leaks
7. **Jito bundles swap + tip atomically** — always sends via standard RPC too as fallback
8. **Paper mode uses real quotes with degraded fills** — not perfect-fill assumptions
9. **Failed exits never close positions** — position stays open for retry on next update cycle
10. **Metrics persist across restarts** — loaded from `data/metrics.json` on startup

## Environment

- **Runtime**: Node.js + TypeScript (tsx for dev, tsc for build)
- **Dependencies**: @solana/web3.js, bs58, dotenv, ws
- **Dev deps**: typescript, tsx, vitest
- **RPC**: Helius (free tier for dev, $49/mo developer for live)
- **DEX**: Jupiter v6 API (quote + swap)
- **Priority**: Jito block engine (mainnet)
- **Data**: JSON files in data/ (no database needed yet)
- **Tests**: `npm test` — vitest, 8 safety tests
