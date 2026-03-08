# Research Workflow

## Output Hierarchy

Treat outputs in this order:

1. raw sweep CSVs
2. candidate-ranked CSVs
3. robustness exact / family rankings
4. live-map patching

Robustness is now built from raw window sweep rows, not only from already-filtered candidates.
That makes it useful as a truth layer instead of a promotion echo chamber.

## Standard Sweep Run

Run separate full sweeps per timeframe:

```bash
npm run sweep -- --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 5 --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 15 --cost empirical --from 2026-02-18 --exit-parity both
```

Optional subsets for faster research:

```bash
npm run sweep -- --template-set core --timeframe 1 --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --template-set trend --timeframe 15 --cost empirical --from 2026-02-18 --exit-parity both
```

Useful flags:
- `--out-file` for scratch runs
- `--template-set core|extended|trend`
- `--exit-parity indicator|price|both`

## Candidate Extraction

Generate candidates from explicit files, never from whatever happens to be latest:

```bash
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-1min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-5min.csv --top 2000 --top-per-token 300
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-15min.csv --top 2000 --top-per-token 300
```

Cross-timeframe union:

```bash
npm run sweep-candidates -- --files "data/sweep-results/YYYY-MM-DD-1min.csv,data/sweep-results/YYYY-MM-DD-5min.csv,data/sweep-results/YYYY-MM-DD-15min.csv" --top 2000 --top-per-token 300 --timeframe-support-min 1
```

Candidate ranking is now profit-first by default.
Do not use raw win rate as the primary decision metric.

## Robustness

Standard rolling-window robustness:

```bash
npm run sweep-robustness -- --from 2026-02-18 --window-days 1,2 --step-days 1 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 2000 --top-per-token 300
```

Rebuild a completed window set without rerunning windows:

```bash
npm run sweep-robustness -- --rebuild-run-dir data/sweep-results/window-robustness/run-YYYY-MM-DDTHH-mm-ss-sssZ
```

Generate the report:

```bash
npm run robustness-report
npm run robustness-report -- --run-dir data/sweep-results/window-robustness/run-YYYY-MM-DDTHH-mm-ss-sssZ --top 25
```

Important robustness outputs:
- `window-raw.csv`
- `stability-exact-ranked.csv`
- `stability-family-ranked.csv`
- `robustness-summary.md`
- `decision-matrix.csv`

### How to read them

- `stability-exact-ranked.csv`
  Exact parameter stability by token / regime / template / timeframe.

- `stability-family-ranked.csv`
  Template-family stability when exact params drift but the same setup class keeps working.

- `robustness-summary.md`
  Human summary of backdrop, regime mix, and top exact / family rows.

## Promotion Rules

Promote a route only when all of these hold:
- profitable on the full raw sweep
- regime-specific edge is coherent
- robustness exact row is acceptable, or family support is strong enough to justify it
- exit mode is live-expressible
- drawdown and hold profile are acceptable for the token tier

Use this order:
1. raw full-period result
2. exact robustness
3. family robustness
4. candidate rank

## Live Map Workflow

1. run fresh sweep(s)
2. run candidates
3. run robustness
4. compare raw exact rows against robustness exact rows
5. patch `config/live-strategy-map.v1.json`
6. deploy and observe live exits

## Reports

Other useful reports:

```bash
npm run template-health
npm run slippage-report
npm run daily-qa-report
```

## Current Modeling Notes

- Backtest uses closed-candle signals and 1 minute execution bars under higher-timeframe routes.
- Dynamic regime changes are supported inside full sweeps.
- Protection exits, including profit lock, are represented in backtest.
- Live-only infrastructure failure modes still need judgment when interpreting results.
