# Sol-Trader Review (Phase 3 Re-Audit)

Date: 2026-02-11
Scope reviewed: `sol-trader/src`, `sol-trader/config/strategy.v1.json`, `sol-trader/package.json`
Validation run: `npx tsc --noEmit` (passes)

## Findings (Ordered by Severity)

1. **Critical - Full-exit failures can still close positions as if they were exited.**
File refs: `sol-trader/src/execution/position-manager.ts:266`, `sol-trader/src/execution/position-manager.ts:291`, `sol-trader/src/execution/position-manager.ts:292`
Issue: after `executeExit`, position closure is triggered when `sellPct >= 100` regardless of whether the sell transaction succeeded.
Impact: positions can be marked closed with zero proceeds after a failed exit, corrupting PnL and risk state.

2. **High - Trade dedup cache is effectively unbounded (memory growth risk).**
File refs: `sol-trader/src/analysis/trade-tracker.ts:12`, `sol-trader/src/analysis/trade-tracker.ts:15`, `sol-trader/src/analysis/trade-tracker.ts:136`, `sol-trader/src/analysis/trade-tracker.ts:137`, `sol-trader/src/analysis/trade-tracker.ts:138`
Issue: `processedSignatures` keeps growing; the "prune" code iterates but never deletes entries.
Impact: long-running process accumulates signatures indefinitely, raising memory pressure and eventual instability.

3. **High - Token age is still based on detection time, not on-chain creation time.**
File refs: `sol-trader/src/analysis/token-data.ts:131`, `sol-trader/src/index.ts:71`
Issue: `tokenAgeMins` is calculated from `launch.detectedAt`.
Impact: age filters can be wrong after monitor lag/restarts, causing false accept/reject decisions in the core universe filter.

4. **Medium - Jito integration does not actually apply a tip instruction to the sent swap transaction.**
File refs: `sol-trader/src/execution/jito-bundle.ts:33`, `sol-trader/src/execution/jito-bundle.ts:45`, `sol-trader/src/execution/jupiter-swap.ts:168`
Issue: `sendWithJito` submits the already-built swap transaction; `tipLamports` is logged but not attached to tx instructions, and tip helper is unused.
Impact: inclusion improvement from Jito may be materially weaker than assumed.

5. **Medium - Asynchronous unsubscribe in token cleanup is not awaited.**
File refs: `sol-trader/src/index.ts:59`, `sol-trader/src/index.ts:62`
Issue: `cleanupToken` calls async `unsubscribeFromToken` without awaiting completion.
Impact: stale listeners can persist temporarily under churn, increasing noisy events and resource usage.

6. **Medium - Execution path still has dead/unused logic and imports in critical modules.**
File refs: `sol-trader/src/execution/jupiter-swap.ts:123`, `sol-trader/src/execution/jito-bundle.ts:6`, `sol-trader/src/execution/jito-bundle.ts:8`, `sol-trader/src/execution/jito-bundle.ts:47`
Issue: `preBalanceLamports` is unused; `TransactionMessage`, `getConnection`, and `keypair` are unused in Jito path.
Impact: this is a maintainability smell in high-risk code paths and increases chance of incorrect assumptions lingering.

7. **Medium - No automated test target exists for rapidly changing risk/execution logic.**
File refs: `sol-trader/package.json:6`
Issue: there is no `test` script or minimal integration checks.
Impact: regression probability remains high while Phase 3 continues moving quickly.

## What Improved Since Last Review

1. Amount/unit handling is substantially improved in swap and position tracking (decimal-aware quote parsing and raw-token sell conversion).
2. LP change guard is now wired into entry filtering and evaluated.
3. Trade enrichment now uses parsed transactions, improving buyer wallet and price/size quality.
4. Paper mode private-key handling is improved (ephemeral keypair fallback).
5. Subscription cleanup path was introduced (`cleanupToken` + `unsubscribeFromToken`).

## Open Questions

1. Should a failed `sellPct=100` exit always keep the position open and schedule retry, or trigger a dedicated emergency state?
2. Do you want a bounded LRU for `processedSignatures`, or per-token TTL-based dedup?
3. Is the target for age filter truly mint creation time (on-chain) versus first-listing time from monitor?

## Recommended Priority Fix Order

1. Fix position close condition so failed full exits cannot close positions.
2. Implement real pruning for `processedSignatures` (bounded LRU/TTL).
3. Switch token age source to on-chain mint creation timestamp/slot.
4. Either wire real Jito tip semantics into tx flow or downgrade Jito claims in docs/status.
5. Add a thin test harness for exit-state transitions and unit conversions.
