# Codex Review — CRSI Scalper (POPCAT)

Date: 2026-02-13

## Findings
**Strategy viability**
- Proposed scalper: CRSI <= 20, TP +0.42%, SL -0.20%, max slippage 0.10%.
- Breakeven hit rate depends heavily on *round‑trip cost* (slippage + fees):
  - If total cost ~0.10%, breakeven win rate ≈ 48.4%.
  - If total cost ~0.15%, breakeven win rate ≈ 56.5%.
  - If total cost ~0.20%, breakeven win rate ≈ 64.5%.
- This can work only if slippage is reliably sub‑0.10% and fills are consistent.

**Position sizing**
- Tight pips require small size relative to liquidity.
- Rule of thumb for this setup: **trade size ≤ 0.05% of pool liquidity**.
  - With ~$3.7M liquidity, upper bound ≈ $1,850 (~23 SOL).
  - Recommended start size: **1–5 SOL** until 200–400 trades validate hit rate.

**Liquidity requirements**
- To keep slippage under 0.10%:
  - 5 SOL trades → $800k+ liquidity
  - 10 SOL trades → $1.6M+ liquidity
  - 50 SOL trades → $8M+ liquidity
  - 100 SOL trades → $16M+ liquidity

## Implementation Strategy (for Claude)
**Goal:** enforce adaptive position sizing based on pool liquidity to keep slippage acceptable.

### Step 1: Liquidity‑based position cap
Add a cap such that:
```
maxPositionUsd = liquidityUsd * 0.0005   // 0.05%
maxPositionSol = maxPositionUsd / solPrice
finalPositionSol = min(configuredMaxPositionSol, maxPositionSol, equityPctCap)
```

### Step 2: Slippage guard before entry
If real‑time Jupiter quote for the requested size exceeds 0.10% price impact or slippage:
```
reject entry with reason "slippage too high"
```

### Step 3: Dashboard visibility
Add to dashboard:
- Current liquidity
- Max allowed position size
- Current trade size
- Latest quoted price impact

### Step 4: Sample size gate
Require at least **200 trades** before scaling above 5 SOL.

## Operational Guidelines
- Keep `PAPER_TRADING=true` until 200–400 trades confirm hit rate.
- Do not widen size if slippage > 0.10% on any leg.
- If hit rate falls under 48–50%, widen TP or add confirmation.

## Note on Execution Responsibility
Codex should advise and scope changes; Claude should implement unless explicitly asked.
