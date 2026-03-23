# Claude Verification Handoff

Please review the current `sol-trader` working tree with a correctness-first lens.

Goal of this batch:
- keep the recent daily-PnL fix intact
- add per-route `live` / `paper` execution support instead of global-only execution mode
- improve attribution so signal -> execution -> trade -> closed trade can be tied together more cleanly
- make the dashboard show the new state clearly enough for live operations

## What Changed

### 1. Per-route execution mode support
- `src/strategy/live-strategy-map.ts`
  - added `RouteExecutionMode = 'live' | 'paper'`
  - added optional `executionMode` to route-capable strategy config shapes
  - normalization now carries `executionMode` into live route objects
- `src/execution/types.ts`
  - `StrategyPlan` now includes optional `decisionId` and `executionMode`
- `src/index.ts`
  - winner plans now carry `decisionId` and `executionMode`
- `src/execution/position-manager.ts`
  - added `resolveExecutionMode(strategyPlan?)`
  - `executeBuy` / `executeSell` now choose paper vs live from route plan first, then fall back to global config
  - live swap path passes route context into Jupiter trade logging

### 2. Richer attribution / logging
- `src/data/data-logger.ts`
  - signals now can log `decisionId`, `exitMode`, `executionMode`, `entryReason`
  - executions now can log `decisionId`, `positionId`, route/template/timeframe/regime metadata, `exitMode`, `executionMode`, `entryReason`
- `src/execution/jupiter-swap.ts`
  - added `TradeContext`
  - swap/trade logs can now persist `decisionId`, `positionId`, route/template/timeframe/regime metadata, `exitMode`, `executionMode`, `entryReason`
- `src/strategy/metrics.ts`
  - closed trade metrics now keep `decisionId`, route/template/timeframe/regime metadata, `exitMode`, `executionMode`
- `src/index.ts`
  - added `createDecisionId(...)`
  - both rejected and accepted signal logs now carry route metadata and execution mode

### 3. Portfolio/dashboard improvements
- `src/strategy/rules.ts`
  - `PortfolioState` now includes `openPnlUsdc` and `dailyTotalPnlUsdc`
- `src/execution/position-manager.ts`
  - `getPortfolioState()` now returns `openPnlUsdc` and `dailyTotalPnlUsdc`
- `src/dashboard/server.ts`
  - status payload now exposes open-position `executionMode`
  - signal payload now exposes route/token execution mode in both selected route and `allRegimeRoutes`
- `src/dashboard/page.ts`
  - top badge can show `LIVE`, `PAPER`, or `MIXED`
  - route list includes route execution mode
  - portfolio cards now split into `Daily Realized`, `Open PnL`, and `Daily Total`
  - open positions now show route execution mode
  - performance view shows `Live / Paper` counts
  - trades table shows each trade's `Mode: LIVE/PAPER`

### 4. Daily PnL fix from the prior bug hunt
- `src/execution/position-manager.ts`
  - daily saved stats were previously recomputed from all historical closed positions
  - they are now recomputed for the current UTC day only
  - dashboard daily values are now based on actual daily stats instead of lifetime closed PnL

## Files In Scope
- `src/dashboard/page.ts`
- `src/dashboard/server.ts`
- `src/data/data-logger.ts`
- `src/execution/jupiter-swap.ts`
- `src/execution/position-manager.ts`
- `src/execution/types.ts`
- `src/index.ts`
- `src/strategy/live-strategy-map.ts`
- `src/strategy/metrics.ts`
- `src/strategy/rules.ts`

## What To Verify Carefully

### A. Route-level execution behavior
- If global mode is live, does a route with `executionMode: 'paper'` stay fully paper across:
  - entry execution
  - exit execution
  - execution logs
  - trade logs
  - closed-trade metrics
- If global mode is paper, does a route with `executionMode: 'live'` correctly force live execution?
- Are there any codepaths that still implicitly assume global paper mode is the only mode?

### B. Attribution continuity
- Does one accepted decision now have enough metadata to tie together:
  - signal log
  - execution log
  - Jupiter trade log
  - closed trade metric
- Check for any places where `decisionId`, `routeId`, `templateId`, or `executionMode` can silently disappear.

### C. Dashboard correctness
- Does `Daily Total` align with `dailyPnlUsdc + openPnlUsdc`?
- Is the top `MIXED` badge logic sound when some routes are paper and some live?
- Is there any place where the dashboard still misleads operators by mixing live and paper results without enough context?

### D. Daily stats regression risk
- Confirm the newer route-level execution changes did not accidentally disturb the earlier daily-PnL fix in `position-manager.ts`.

## Known Limitations / Possible Follow-ups
- There is still no dashboard filter that separates aggregate performance metrics by live vs paper; only counts and per-trade mode are surfaced.
- I did not add a dedicated regression test for per-route execution mode yet.
- Config/docs examples for setting `executionMode` on individual routes have not been added yet.

## Validation Already Run
- `npm test`
- `npx tsc --noEmit`

Both passed after the final edits.

## Latest Additions: Strategy Review Automation

There is now a new automation path for dual-window research runs:

- `scripts/strategy-review-run.ts`
- `package.json` script entry: `npm run strategy-review-run`
- `scripts/live-candidate-summary.ts` now accepts:
  - `--candidate-dir`
  - `--sweep-dir`
  - `--out-dir`
- `docs/STRATEGY_REVIEW_RITUAL.md` now documents the automated runner

### Intent

This runner is meant to orchestrate:

- recent real-volume bundle: `2026-03-14 -> review date`
- full-history bundle: `2026-02-18 -> review date`
- sweeps
- candidates
- robustness
- robustness report
- template health
- live candidate summary
- QA + slippage support reports
- summary + agent prompt kit

### What To Verify

- The runner writes outputs into isolated tagged bundle directories and does not depend on the default `data/sweep-results` location.
- `live-candidate-summary.ts` correctly reads from explicit bundle dirs, not only global defaults.
- The generated summary heuristic is directionally sound and does not overstate confidence.
- The recommendation logic is conservative enough when recent and full-history windows disagree.
- The prompt-kit paths and manifest paths are correct for a later multi-agent pass.

### Validation Already Run For This Addition

- `npx tsc --noEmit`
- `npm run strategy-review-run -- --dry-run --to 2026-03-22 --out-root data\\strategy-review-runs\\dry-run-check`

## Latest Additions: SOL Probation + Paper Shortlist

This follow-up batch is specifically about operating with one live probation route while collecting cleaner evidence on paper candidates.

### Intent

- keep `sol-15m-rsi2-side-research` as the only explicit live route for now
- enable the shortlisted candidates in per-route paper mode
- prevent paper trades from polluting live risk controls, live daily PnL, or operator-facing equity
- improve attribution so the next promotion decision can join route params/protection/close reasons more cleanly

### Config / Route State

- `config/live-strategy-map.v1.json`
  - `sol-15m-rsi2-side-research` is now explicitly `executionMode: "live"`
  - enabled paper-only shortlist routes:
    - `pippin-5m-bb-squeeze-volume-side-paper`
    - `pippin-1m-adx-range-side-paper`
    - `pump-1m-rsi-session-side-paper`
    - `sol-1m-rsi-session-side-paper`

### Runtime Isolation

- `src/execution/position-manager.ts`
  - live portfolio state now excludes paper positions from:
    - `equityUsdc`
    - `openPositions`
    - `openExposureUsdc`
    - `dailyPnlUsdc`
    - `dailyTotalPnlUsdc`
    - kill-switch / exposure / max-position enforcement
  - added paper-side tracking fields:
    - `dailyPaperPnlUsdc`
    - `paperOpenPositions`
    - `paperOpenExposureUsdc`
    - `paperOpenPnlUsdc`
    - `dailyPaperTotalPnlUsdc`
  - paper closes no longer affect:
    - live consecutive loss streak
    - live stopout lockouts
    - route cooldown counters
  - close-side timestamps now use the actual exit timestamp for live loss/cooldown bookkeeping

### Attribution / Parity Improvements

- `src/index.ts`
  - signal logs now classify gates with structured `gateType`
  - route-window skips now emit `blockedRouteIds`
  - accepted/rejected decisions include stable `paramsKey` and `protectionKey`
  - status logs now expose both live and paper open-position counts/exposure
- `src/data/data-logger.ts`
  - signal and execution payloads now carry `gateType`, `blockedRouteIds`, `paramsKey`, `protectionKey`, and sell-side `closeReason`
- `src/strategy/route-fingerprint.ts`
  - added canonical helpers for stable param/protection fingerprints
- `src/strategy/metrics.ts`
  - closed trade metrics now retain `paramsKey`, `protectionKey`, and `closeReason`

### Dashboard / Operator View

- `src/dashboard/page.ts`
  - portfolio cards now keep live equity separate from paper open notional
  - open-trades card now shows live vs paper counts and notionals
  - performance cards now split `Live PnL` and `Paper PnL` instead of a single mixed total
- `src/dashboard/server.ts`
  - signal stat grouping prefers structured gate fields, especially for `route-window`

### Tests Added / Updated

- `test/daily-stats.test.ts`
  - added coverage that paper closes stay out of live daily PnL and live loss streaks
- `test/route-fingerprint.test.ts`
  - verifies stable param/protection fingerprint generation

### Known Limitation To Verify

- Mixed live/paper on the same token is still not true shadow mode.
  - Route arbitration still chooses one winning route per token/regime/cycle.
  - That means a lower-priority paper route does not automatically mirror every live opportunity on the same token.
  - The paper shortlist is useful for collection and comparison, but not full parallel route shadowing.

### Validation Already Run For This Addition

- `npm test`
- `npx tsc --noEmit`
