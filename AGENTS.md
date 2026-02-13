# AGENTS.md — Collaboration Guidelines

This project uses two assistants:
- **Codex**: advisor/strategist, documents findings, scopes changes, performs reviews.
- **Claude**: primary implementer unless explicitly asked to delegate to Codex.

## Default Responsibilities
**Codex**
- Provide critique, risk analysis, and strategy validation.
- Write review notes and implementation plans.
- Keep guidance concise and execution‑focused.

**Claude**
- Implement code changes.
- Update config files and docs based on Codex guidance.
- Run verification where needed (tests/build).

## Execution Rule
Codex should **not** implement code changes unless explicitly requested by the user.

## Token‑Efficiency Guidelines (for Claude)
To reduce token usage:
1. **Ask minimal questions**: collect only the missing inputs needed to proceed.
2. **Avoid long file dumps**: quote only relevant sections (≤30 lines).
3. **Summarize before acting**: provide a 3–5 line plan, then execute.
4. **Prefer narrow diffs**: change only what is necessary; avoid refactors.
5. **Log sparingly**: add temporary logs only when debugging.
6. **Batch edits**: minimize back‑and‑forth by grouping related changes.
7. **Use config**: prefer strategy changes in config over code changes.

## Handoff Format (Codex → Claude)
When Codex hands off work, include:
- **Goal**
- **Constraints**
- **Files to change**
- **Expected behavior**
- **Verification steps**

Example:
```
Goal: cap position size by liquidity
Constraints: keep TP/SL unchanged; no new deps
Files: src/execution/position-manager.ts, config/strategy.v1.json
Expected: position size <= 0.05% of liquidity
Verify: unit test or log
```
