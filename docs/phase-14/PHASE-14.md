# Phase 14: Integration Correctness

## Purpose

A live test against a real project surfaced a load-bearing failure: a user
who disables `claude-code` in `yaao.config.json` and keeps only `copilot`
active runs `yaao plan` and `yaao run`, and **claude-code agents spawn
anyway**. The same audit caught four related defects across the agent
backends, the planner skill, the run command, the converter's fallback
logic, the MCP overlay path, and one outright-false claim in the README
(Anthropic prompt caching).

Phase 14 fixes all of them before v1 ships. Each one is small and
localized; together they make the four-agent / API matrix actually
honor the user's config and the docs match the code.

This phase is sequenced **before** release polish (now Phase 15) because
polish is wasted effort on top of a broken enable/disable contract — the
quickstart in `examples/` and the `yaao doctor` audit both rely on
"disabling an agent actually disables it." Concurrent runs (Phase 16)
and everything beyond also benefit from a config-honoring engine first.

## Features

| Feature | Description | Doc |
| --- | --- | --- |
| **F14.1** | Enable-disable enforcement end-to-end (planner, converter, validate, run, MCP) | [F14.1-enable-disable-enforcement.md](F14.1-enable-disable-enforcement.md) |
| **F14.2** | Per-spawn MCP overlays for Cursor / Codex / Copilot | [F14.2-per-spawn-mcp-overlays.md](F14.2-per-spawn-mcp-overlays.md) |
| **F14.3** | API provider truth-up (Anthropic prompt caching, OpenAI/OpenRouter stub gating) | [F14.3-api-provider-truthup.md](F14.3-api-provider-truthup.md) |
| **F14.4** | Live backend smoke tests (Cursor / Codex / Copilot / Anthropic) | [F14.4-live-backend-smoke-tests.md](F14.4-live-backend-smoke-tests.md) |
| **F14.5** | Spec Kit parser hardening + content propagation | [F14.5-speckit-hardening.md](F14.5-speckit-hardening.md) |

## Why now

The pre-flight audit (May 2026) found that yaao's published surface
overstates its real integration support. Specifically:

- **Disabling an agent doesn't disable it.** [src/cli/commands/run.ts:212](../../src/cli/commands/run.ts#L212)
  constructs the backend straight from `task.agent` without consulting
  `agents.<name>.enabled`. `yaao run` never calls `validatePlan` either,
  so the existing `YAAO_PLAN_AGENT_DISABLED` error is dead code in the
  normal flow.
- **The planner skill can't see config.** [src/skills/builtin/yaao-planner/skill.yaml](../../src/skills/builtin/yaao-planner/skill.yaml)
  has only `description, scope, format, out` — no list of enabled agents.
  The prompt's worked examples hard-code `claude-code` for most tasks,
  so the model emits `claude-code` regardless of what the user actually
  has set up.
- **Three of four CLI backends ignore per-spawn MCP servers.** Only
  [ClaudeCodeBackend.spawn](../../src/agents/claude-code.ts#L131) reads
  `spawn.mcpServers`. Cursor/Codex/Copilot inherit from `SubprocessBackend`
  which never touches the field — so `context.mcp-servers:` in a plan,
  ctx-sys auto-spawn, and any per-run MCP wiring silently disappear for
  three of the four CLI agents. The agents reach yaao's own MCP server
  *only* via static `yaao skills install` config, which can't carry
  per-run state.
- **Anthropic prompt caching is claimed but not wired.** The README
  says "Anthropic SDK with prompt caching" but
  [AnthropicProvider.step](../../src/agents/api/backend.ts#L277) builds
  the request body with no `cache_control` markers anywhere.
- **OpenAI and OpenRouter providers are stubs that throw at spawn
  time.** Validation should catch this; today it doesn't.
- **Non-Claude backends have argv-only test coverage.** No live spawn,
  no output-parser verification, no smoke proof that the documented CLI
  shapes still match the actual `cursor-agent`, `codex exec`, or `gh
  copilot agent run` surfaces.
- **Spec Kit parsing is brittle.** The task-line regex is strict; a
  slightly-off `tasks.md` parses as zero tasks with no warning. `spec.md`
  and `plan.md` content is dropped — only title/description extracted.

## Implementation order

1. **F14.1** first. Closes the user-visible bug end-to-end. Three small
   PRs would also work (planner input + run-time gate + converter
   fallback) but they're small enough to land together.
2. **F14.2** second. Mechanical change per backend; the contract is
   identical to ClaudeCodeBackend's MCP overlay. Without this, ctx-sys
   integration (Phase 7) is silently broken for three of four agents
   and the Phase 16 concurrent-runs story has a gap.
3. **F14.3** third. Smaller scope: either add caching markers or strip
   the claim; add a validation rule for stub providers.
4. **F14.4** fourth. Backstops the rest of the phase. Live smoke tests
   prove F14.1 + F14.2 actually work against real CLIs, not just our
   parsers' assumptions about them.
5. **F14.5** last. Lowest-impact of the five; surfaces today's silent
   parser failures and propagates Spec Kit content that's currently
   dropped on the floor.

## Out of scope

- **Building OpenAI and OpenRouter providers.** F14.3 turns the stubs
  into a hard validation error so users see the gap. Implementing the
  providers themselves is a separate piece of work (likely sequenced
  with Phase 16 + 17 — after distillation lands, before npm publish).
- **A unified MCP-overlay primitive across all four backends.** F14.2
  ships the per-backend overlay each agent's CLI actually accepts. A
  factored-out `writeMcpOverlay(agent, servers)` helper is a v2 cleanup,
  not phase-blocking.
- **Reworking the planner skill's prompt structure.** F14.1 adds the
  enabled-agents input and updates the worked-example tables. A larger
  rewrite (e.g. per-stack planning templates) belongs to a different
  phase.
- **`yaao doctor`-style end-to-end agent probing.** The shipped
  per-backend `isAvailable()` plus F14.1's config-aware spawning is
  sufficient. The probe layer doctor consumes is unchanged.
