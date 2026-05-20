# Phase 14: Release Polish

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
| **F14.1** | `yaao doctor` — environment audit + folds in `yaao agents` | [F14.1-doctor.md](F14.1-doctor.md) |
| **F14.2** | `yaao init --mcp` — auto-register yaao's MCP server in `.mcp.json` | [F14.2-init-mcp.md](F14.2-init-mcp.md) |
| **F14.3** | First-use experience — 60-second quickstart + `examples/` directory | [F14.3-first-use.md](F14.3-first-use.md) |
| **F14.4** | Error message + hint audit | [F14.4-error-hints.md](F14.4-error-hints.md) |
| **F14.5** | README + IMPLEMENTATION.md accuracy pass | [F14.5-docs-truthup.md](F14.5-docs-truthup.md) |
| **F14.6** | End-to-end pre-release validation on real projects | [F14.6-prerelease-validation.md](F14.6-prerelease-validation.md) |

## Why now

Phases 1-13 built the engine. The first-use story still has small but
load-bearing gaps:

- A new user runs `yaao init`, then has to hand-edit `.mcp.json` before Claude
  Code / Cursor / etc. can see yaao at all (F14.2 closes this).
- A new user with a missing `claude` binary discovers the problem mid-run when
  a task fails to spawn (F14.1 surfaces it as a preflight).
- The README is comprehensive but dense; there's no "copy these five lines and
  watch it work" path (F14.3).
- Several scope decisions are documented one way and shipped slightly
  differently (API backend status, `--scope project` maturity); the docs
  truth-up pass (F14.5) closes that gap before the README becomes the v1
  source of truth.
- Nothing in the suite tests yaao end-to-end on a real codebase the team
  doesn't already own (F14.6 — the human-in-the-loop validation that fixes
  things the unit tests miss).

## Implementation order

1. **F14.1 + F14.2** — high-leverage, low-risk. Once these land the
   first-use story works end-to-end without docs telling the user to edit
   JSON files by hand.
2. **F14.5** — the README pass. Cheap, makes everything downstream truthful.
3. **F14.3** — quickstart + examples. Builds on F14.1/F14.2 (they're the
   "first three commands" the quickstart runs).
4. **F14.4** — error-message audit. Touches every command's failure paths;
   wants the rest of the phase stable first so we're not chasing a moving
   target.
5. **F14.6** — pre-release validation. Last because it's the gating step
   before tagging v1; running it earlier just means running it twice.

## Out of scope

- New product features. Anything that adds an MCP tool, a CLI command, or a
  plan schema field belongs to a different phase.
- Performance work. Phase 14 is correctness + polish; bench/optimize is v2
  territory unless something is *visibly* slow during F14.6.
- `merge: pr` mode polish — left as-is for now; revisit after v1.
