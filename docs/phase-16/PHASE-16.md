# Phase 16: Session → Skill Distillation

**Status**: Planned
**Depends on**: Phase 8 (skills system), Phase 12 (yaao-as-MCP — specifically F12.5 auto-registration *and* [F12.6](../phase-12/F12.6-skill-hot-reload.md) hot reload, which delivers the "callable across all connected agents within the same MCP session" UX this phase relies on)

## Goal

Capture the useful patterns from a finished chat session — the conventions discovered, the file/dir focus areas, the user's corrections, the ordered approach that actually worked — and crystallize them into a reusable yaao skill. The skill is then immediately available to **every** agent connected to yaao's MCP server (Claude Code, Cursor, Copilot, Codex, raw API), regardless of which agent the original session ran in.

This phase closes a missing half of the skill lifecycle: yaao already makes a written skill *portable*. Phase 16 makes the act of *writing* the skill cheap by lifting it out of a representative session you already had.

## Why this belongs in yaao

Three properties of the existing yaao skill system make the fit unusually clean:

1. **One canonical skill format** (`skill.yaml` + `prompt.md`, F8.1) already exists — the distiller emits into the same shape every other skill uses.
2. **Auto-MCP-registration plus hot reload** (F12.5 + [F12.6](../phase-12/F12.6-skill-hot-reload.md)) means any skill written to `.yaao/skills/<name>/` becomes a callable tool `yaao_skill_<name>` within one debounce window (~250 ms), across all connected agents. F12.5 covers the static catalog at server build; F12.6 keeps it in sync mid-session via an `fs.watch`-driven reconciler that fires `tools/list_changed`. No reconnect, no further wiring.
3. **Per-agent emitters** (F8.2–F8.5) already translate one canonical skill into each agent's native artifact via `yaao skills install`. Distillation just produces the canonical form; the existing pipeline takes it the rest of the way.

A skill written from a Claude Code session is therefore usable from Cursor, Copilot, Codex, and the raw API tomorrow — same name, same inputs, same body.

## Features

| Feature | Description | Doc |
| --- | --- | --- |
| **F16.1** | `yaao-distiller` built-in skill (prompt + metadata) | [F16.1-distiller-skill.md](F16.1-distiller-skill.md) |
| **F16.2** | In-session capture (structured self-summary contract, redaction) | [F16.2-session-readers.md](F16.2-session-readers.md) |
| **F16.3** | Skill emission, validation, and post-emit `skills install` | [F16.3-skill-emission.md](F16.3-skill-emission.md) |
| **F16.4** | `yaao_distill` MCP tool (sole entry point) | [F16.4-distill-mcp-tool.md](F16.4-distill-mcp-tool.md) |
| **F16.5** | Skill refinement (re-distill with new session, diff review) | [F16.5-skill-refinement.md](F16.5-skill-refinement.md) |

## Key Deliverables

- `yaao-distiller` sits next to `yaao-planner` and `yaao-converter` in `src/skills/builtin/` and is registered as the MCP tool `yaao_distill` (custom, parallel to `yaao_plan` / `yaao_convert`).
- **MCP is the only entry point.** Distillation is inherently an in-context operation — its primary input is "what just happened in this conversation," which only meaningfully exists inside the conversation. Unlike every other yaao command, there is no shell-CLI equivalent: a shell user can't construct a useful `SessionRecord` from memory, and every supported agent already speaks MCP. The symmetry-break with the rest of yaao is intentional.
- **In-session capture.** The invoking agent supplies its own structured self-summary of the conversation as the `session` MCP argument; yaao never reads IDE-internal transcript stores. This works on every agent (Claude Code, Cursor, Copilot, Codex, raw API).
- The new skill is written to `.yaao/skills/<name>/` (project) or `~/.yaao/skills/<name>/` (user), reusing `validateSkill` (F8.1) before persisting. After write, F8.6's `skills install` re-emits per-agent stubs automatically.
- Re-running the distiller against an existing skill **merges** rather than overwrites — preserving anti-patterns and distillation notes, surfacing a diff + changelog for review, and refusing auto-apply on convention contradictions. **Version history lives in git** (`.yaao/skills/` is repo-tracked); yaao does not touch the `version` field on refinement and keeps no parallel backup directory.

## Implementation Order

F16.1, F16.2, and F16.3 are tightly coupled and should land as a single PR, not three:

- F16.1's prompt has to know what shape of `SessionRecord` to expect (defined in F16.2).
- F16.1's emitted output has to pass `validateSkill` as F16.3 calls it; if the prompt is wrong the validator rejects.
- F16.3's idempotency guarantees (atomic write, refuse-overwrite-without-merge) only matter if F16.1 is actually producing files.

Sequence:

1. **F16.1 + F16.2 + F16.3** together — `SessionRecord` contract, distiller prompt, emission pipeline. End state: a hand-built `SessionRecord` fed into `runPlanner`-style harness produces a written, validated skill on disk.
2. **F16.4** — the MCP tool wires everything together end-to-end and surfaces it to calling agents. F12.6 hot reload (already shipped) makes the new tool callable in the same session.
3. **F16.5** last — refinement is the multiplier, but only meaningful once F16.1–F16.4 have produced a few real skills.

## Removing a bad skill

A distilled skill that turns out wrong is recovered by deleting `.yaao/skills/<name>/` and re-running `yaao skills install` to reap per-agent stubs. F12.6's watcher fires `tools/list_changed` on directory deletion, so the stale `yaao_skill_<name>` tool drops from connected clients in the same session. `yaao_prune` does not currently cover skills — adding `target: skill` is a possible follow-up but out of scope for this phase.

## Non-goals

- **Auto-detecting when a session is "skill-worthy."** The user knows whether they'll do this kind of work again better than any heuristic. Distillation is always user-invoked.
- **A `yaao distill` CLI command.** Distillation is in-context only — see Key Deliverables. Skill *management* commands (list, view, remove) may live under `yaao skills` later, but those are Phase 8 surface, not Phase 16.
- **Running the distilled skill server-side.** Same model as F12.5 — yaao produces the skill; the calling agent uses it.
- **Cross-session synthesis** (combining N unrelated sessions into one skill). Out of scope for v1; refinement (F16.5) handles the iterative case.
- **`yaao_prune` coverage for skills.** Recovery is `rm -rf` + `skills install`; see above.
