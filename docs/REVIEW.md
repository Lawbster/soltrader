# Sol-Trader Review — Post‑Claude Changes

Date: 2026-02-13  
Scope: `config/strategy.v1.json`, `src/strategy/rules.ts`, `src/strategy/strategy-config.ts`, `src/execution/position-manager.ts`, `src/execution/index.ts`, `src/dashboard/server.ts`, `src/dashboard/page.ts`, `src/index.ts`, `src/analysis/indicators.ts`, `src/analysis/price-feed.ts`.

## Summary
Claude implemented the core risk‑control recommendations: liquidity‑based size cap, pre‑trade slippage gate, sample‑size gate, and dashboard visibility. The design direction is correct and materially reduces blow‑ups during early validation. The remaining blockers are **trade capture reliability** and **execution economics vs. TP/SL**. The dashboard is now strong enough to operate the system, but it still lacks a hard “trade capture OK/FAIL” indicator.

## What Landed (Verified)
1) **Liquidity‑based position cap**  
Config: `position.liquidityCapPct = 0.05` (0.05% of pool liquidity).  
Logic: `calculatePositionSize(...)` caps size using pool liquidity and SOL price.  
Files: `config/strategy.v1.json`, `src/strategy/rules.ts`.

2) **Slippage guard before entry**  
`openPosition()` now does a pre‑flight Jupiter quote and rejects if `priceImpactPct > maxEntryImpactPct`.  
Config: `position.maxEntryImpactPct = 0.10`.  
Files: `src/execution/position-manager.ts`, `config/strategy.v1.json`.

3) **Sample‑size gate**  
Caps size until `totalTrades >= 200`.  
Config: `sampleSizeGateMinTrades = 200`, `sampleSizeGateMaxSol = 5`.  
Files: `src/strategy/rules.ts`, `config/strategy.v1.json`.

4) **Dashboard visibility**  
Signal cards now show liquidity, effective max size, max impact, last quoted impact, and sample‑size progress.  
Files: `src/dashboard/page.ts`, `src/dashboard/server.ts`.

5) **CRSI price‑feed fallback**  
CRSI now runs from Jupiter price history if trade data is insufficient.  
Files: `src/analysis/price-feed.ts`, `src/analysis/indicators.ts`, `src/index.ts`.

## Critical Issues Still Open
1) **Trade capture still not producing recorded trades**  
Swap logs are detected, but `Enriched trade recorded` is not emitted. This blocks any trade‑based metrics and can leave CRSI reliant solely on price polls.  
Impact: metrics remain empty, trade window signals are effectively unusable.

2) **TP/SL vs. slippage mismatch**  
Current TP/SL: `+0.50%` / `-0.25%`.  
Max slippage is still `entry.maxSlippagePct = 2.0` (200 bps), which is far above your scalper edge.  
Impact: even with impact guard, execution cost could erase expectancy.

## Medium Issues / Gaps
1) **Slippage gate uses price impact only**  
`priceImpactPct` is not the same as total execution slippage. If fees or route changes occur, this can still leak risk.

2) **Liquidity is polled every analysis tick**  
`fetchPoolLiquidity()` runs every 30s even in CRSI‑only mode. It adds load without improving signal quality for this simplified strategy.

3) **Dashboard doesn’t show CRSI source explicitly**  
Price‑feed vs. trades is logged but not surfaced as a single clear status banner (“Trade capture OK/FAIL”).

## Compliments (What’s Strong)
- The sizing cap + sample‑size gate combination is the right control surface for safe iteration.
- The dashboard upgrade makes the system operable and observable.
- The CRSI price‑feed fallback was a smart resilience move, allowing the strategy to run even if trade enrichment is flaky.

## Scenarios to Keep in Mind
1) **CRSI triggers but trade capture is broken**  
You’ll see CRSI values and maybe entries, but metrics and trade‑window data remain empty.

2) **Impact guard passes, but slippage still eats edge**  
If `entry.maxSlippagePct` stays at 2.0, you can still lose money at your tight TP/SL.

3) **Liquidity shrinks during session**  
Position cap will reduce size, but if liquidity is volatile you may get frequent entry rejects from impact checks.

## Strategy Going Forward (Pragmatic)
1) **Fix trade capture or stop relying on it**  
Either make trade enrichment reliable or fully commit to price‑feed only and strip trade‑window dependencies.

2) **Align slippage cap with TP/SL**  
If TP is 0.42–0.50%, slippage cap should be ~0.10% or tighter.

3) **Add a dashboard status badge**  
Trade capture: OK / FAIL.  
CRSI source: price‑feed / trades.

## Config Notes (Current)
From `config/strategy.v1.json`:
- `position.maxPositionSol = 1.25` (still the main cap in practice)
- `position.maxEntryImpactPct = 0.10`
- `position.liquidityCapPct = 0.05`
- `position.sampleSizeGateMinTrades = 200`
- `position.sampleSizeGateMaxSol = 5`
- `entry.maxSlippagePct = 2.0` **(too high for tight TP/SL)**

---
If you want, I can add a short action checklist section or adapt this into a Claude handoff template.
