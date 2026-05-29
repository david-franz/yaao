# Phase 15: Release Polish

## Purpose

The work that turns yaao from feature-complete into v1-shippable. None of these
items add new product surface — they shore up the first-use story, fold in
duplicated commands, audit error messages, and make sure the README + scope
labels accurately describe what the engine actually does. Sequenced ahead of
Phases 15 (distillation) and 16 (distribution) so v1 can ship the moment
distillation is ready, without polish gaps waiting in the wings.

## Features

| Feature | Description | Doc |
| --- | --- | --- |
| **F15.1** | `yaao doctor` — environment audit (folds in `yaao agents` + orphan-run detection) | [F15.1-doctor.md](F15.1-doctor.md) |
| **F15.2** | `yaao init --mcp` — auto-register yaao's MCP server in `.mcp.json` | [F15.2-init-mcp.md](F15.2-init-mcp.md) |
| **F15.3** | First-use experience — 60-second quickstart + `examples/` directory | [F15.3-first-use.md](F15.3-first-use.md) |
| **F15.4** | Help text & error message audit | [F15.4-help-and-errors.md](F15.4-help-and-errors.md) |
| **F15.5** | README + IMPLEMENTATION.md accuracy pass | [F15.5-docs-truthup.md](F15.5-docs-truthup.md) |

## Why now

Phases 1-13 built the engine. The first-use story still has small but
load-bearing gaps:

- A new user runs `yaao init`, then has to hand-edit `.mcp.json` before Claude
  Code / Cursor / etc. can see yaao at all (F15.2 closes this).
- A new user with a missing `claude` binary discovers the problem mid-run when
  a task fails to spawn (F15.1 surfaces it as a preflight).
- The README is comprehensive but dense; there's no "copy these five lines and
  watch it work" path (F15.3).
- Several scope decisions are documented one way and shipped slightly
  differently (API backend status, `--scope project` maturity); the docs
  truth-up pass (F15.5) closes that gap before the README becomes the v1
  source of truth.
- Runs killed outside the CLI's signal path (kill -9, `yaao serve` crash
  mid-`yaao_run`) leave the journal saying `running` forever. F15.1's
  doctor now detects these and `yaao_inspect` reports them as
  `aborted` instead of `running`.

## Implementation order

1. **F15.2** — `yaao init --mcp`. Highest impact-per-effort; unblocks
   the quickstart.
2. **F15.1** — `yaao doctor`. Includes orphan-run detection (shared
   with the workspace listing's status pill) so a run killed by
   `kill -9` stops showing as `running` in the web viewer.
3. **F15.3** — quickstart + examples. Builds on F15.1/F15.2 (they're the
   "first three commands" the quickstart runs).
4. **F15.4** — help text + error message audit. Touches every command's
   `--help` output and every `YaaoError` hint; wants the rest of the phase
   stable first so we're not chasing a moving target.
5. **F15.5** — the README + IMPLEMENTATION.md truth-up. Runs last so it
   catches drift introduced by F15.1–F15.4 in the same pass.

## Out of scope

- New product features. Anything that adds an MCP tool, a CLI command, or a
  plan schema field belongs to a different phase. (`yaao doctor` is
  on the line — it's a new command, but it folds in the existing
  `yaao agents` surface and adds no plan-side concepts.)
- Performance work. Phase 15 is correctness + polish; bench/optimize is v2
  territory.
- `merge: pr` mode polish — left as-is for now; revisit after v1.
- End-to-end validation on real projects. Done out-of-band as part of
  the v1 sign-off; not gated by Phase 15.
