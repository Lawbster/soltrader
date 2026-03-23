# Strategy Review Ritual

Use this process for deep strategy review in `sol-trader`.

## Goal

Start with fresh evidence.
Cut stale live routes before brainstorming new ones.
Use two windows:

- a recent real-volume slice for live viability
- a longer full-history slice for sanity

Only add logging when a specific research decision is blocked by a specific missing field.

## Decision Rubric

Apply this order every cycle:

1. Recent real-volume viability
2. Longer-history sanity
3. Exact robustness inside each window
4. Family robustness inside each window
5. Live expressibility and parity
6. Data quality, sample quality, and volume provenance

Rules:

- Do not let a flashy exact row outrank weak family robustness.
- Do not let a full-history winner outrank a recent real-volume failure.
- Do not let a recent winner auto-promote if the longer-history slice materially contradicts it.
- For explicitly volume-sensitive templates, treat the pre-real-volume slice as supporting context, not a hard promotion signal.
- Do not promote routes from candle intuition alone.

## Step 0: Dual Evidence Pack

### Automated Run

For a tagged dual-window run that keeps outputs isolated and writes an evidence manifest, summary, and agent prompt kit:

```bash
npm run strategy-review-run
```

Useful overrides:

```bash
npm run strategy-review-run -- --to 2026-03-22
npm run strategy-review-run -- --full-robustness-timeframes 5,15
npm run strategy-review-run -- --out-root data/strategy-review-runs/review-custom
```

The runner writes:

- `evidence-manifest.json`
- `strategy-review-summary.md`
- `strategy-review-summary.json`
- `agent-prompts/*.md`
- isolated `recent-real-volume/` and `full-history/` bundles
- `support-reports/` for QA and slippage context

### 0A. Recent Real-Volume Slice

Run the recent slice first from the real-volume anchor.
For the current dataset, that anchor is `2026-03-14`.

```bash
npm run sweep -- --timeframe 1  --cost empirical --from 2026-03-14 --exit-parity both
npm run sweep -- --timeframe 5  --cost empirical --from 2026-03-14 --exit-parity both
npm run sweep -- --timeframe 15 --cost empirical --from 2026-03-14 --exit-parity both
```

Then candidates:

```bash
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-1min.csv  --top 2000 --top-per-token 300 --min-worst-other-regime -10
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-5min.csv  --top 2000 --top-per-token 300 --min-worst-other-regime -10
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-15min.csv --top 2000 --top-per-token 300 --min-worst-other-regime -10
```

Then robustness:

```bash
npm run sweep-robustness -- --from 2026-03-14 --window-days 3,5 --step-days 2 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 500 --top-per-token 300
```

Archive these outputs before rerunning the same date with a different `--from`.

### 0B. Full-History Slice

Run the longer slice from the clean research start.
For the current dataset, that anchor is `2026-02-18`.

```bash
npm run sweep -- --timeframe 1  --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 5  --cost empirical --from 2026-02-18 --exit-parity both
npm run sweep -- --timeframe 15 --cost empirical --from 2026-02-18 --exit-parity both
```

Then candidates:

```bash
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-1min.csv  --top 2000 --top-per-token 300 --min-worst-other-regime -10
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-5min.csv  --top 2000 --top-per-token 300 --min-worst-other-regime -10
npm run sweep-candidates -- --file data/sweep-results/YYYY-MM-DD-15min.csv --top 2000 --top-per-token 300 --min-worst-other-regime -10
```

Then robustness:

```bash
npm run sweep-robustness -- --from 2026-02-18 --window-days 3,5 --step-days 2 --timeframes 1,5,15 --cost empirical --exit-parity both --rank-exit-parity indicator --top 500 --top-per-token 300
```

### 0C. Supporting Reports

Use these after the sweep bundles exist:

```bash
npm run robustness-report -- --run-dir data/sweep-results/window-robustness/run-YYYY-MM-DDTHH-mm-ss-sssZ --top 30
npm run template-health -- --files data/sweep-results/YYYY-MM-DD-1min.csv,data/sweep-results/YYYY-MM-DD-5min.csv,data/sweep-results/YYYY-MM-DD-15min.csv --exit-parity both --top 30
npm run daily-qa-report -- --from 2026-03-14 --to YYYY-MM-DD --out data/reports/YYYY-MM-DD.daily-qa-report.md --json-out data/reports/YYYY-MM-DD.daily-qa-report.json
npm run slippage-report -- --from 2026-03-14 --to YYYY-MM-DD --top 12
npm run live-candidate-summary -- --sweep-date YYYY-MM-DD
```

Expected outputs:

- recent-slice sweeps, candidates, and robustness
- full-history sweeps, candidates, and robustness
- live-route summary
- QA and slippage context for the recent real-volume era

## Step 1: Human Comparison Brief

Before any agent pass, write one short analyst brief that answers:

- Which enabled live routes fail both windows?
- Which families survive both windows?
- Which families only win in the recent real-volume slice?
- Which families only win in the longer full-history slice?
- Which results are volume-sensitive enough that the pre-real-volume slice should be discounted?
- What changed versus the current live map?

Every route or candidate mentioned should land in one of:

- `keep`
- `trim`
- `disable`
- `investigate`
- `promote candidate`
- `need more data`

Default rule:

- if there is meaningful cross-window disagreement, use `investigate` or `need more data`, not `promote candidate`

## Step 2: Multi-Agent Review

Use separate agents, not one giant prompt.
All agents should read from the same evidence pack and the same comparison brief.

Required roles:

- stale-route cutter
- new-family finder
- parity and live-feasibility auditor
- data sufficiency auditor

Optional role:

- candle-pattern ideation agent

Every agent should label each conclusion as one of:

- `cross-window`
- `recent-only`
- `full-history-only`
- `volume-sensitive`

The optional candle-pattern pass should only run on a shortlisted set after the first four roles complete.
It is for hypothesis generation, not promotion decisions.

## Step 3: Data Logging Review

Default principles:

- do not log more candle history just because it feels safer
- do add structured route-linked decision-state when it unlocks a real question
- do add volume-provenance-aware research outputs when results depend on the March 14 real-volume cutoff

The most likely useful additions are:

- `realVolumeCoveragePct` and `volumeQualityBucket` in research artifacts
- `decisionId` across signal to execution to trade to metric
- route snapshots on persisted execution and trade rows
- structured skip and arbitration reasons
- structured gate-state snapshots
- explicit missing-indicator tracking
- quote and timing context
- session-level markers

## Deliverables

Each cycle should end with:

- a dated strategy review brief
- a live-route decision memo
- a new-candidate memo
- a data-gap memo

Optional:

- a candle-ideation note for shortlisted families

Recommended location:

- `data/reports/YYYY-MM-DD.strategy-review-brief.md`
- `data/reports/YYYY-MM-DD.live-route-decision-memo.md`
- `data/reports/YYYY-MM-DD.new-candidate-memo.md`
- `data/reports/YYYY-MM-DD.data-gap-memo.md`
- `data/reports/YYYY-MM-DD.candle-ideation-notes.md`

## Notes

- Treat `template-health` as supporting context, not the final decision layer.
- If live candidate summary shows 0 exact matches for enabled routes, assume live-map drift until proven otherwise.
- If recent and full-history bundles disagree, do not force a live promotion from one side.
- If a family depends on volume, recent real-volume evidence should matter more than older mixed-quality candles.
