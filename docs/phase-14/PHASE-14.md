# Phase 14: Integration Correctness

## Purpose

A live test against a real project surfaced a load-bearing failure: a user
who disables `claude-code` in `yaao.config.json` and keeps only `copilot`
active runs `yaao plan` and `yaao run`, and **claude-code agents spawn
anyway**. The same audit caught related defects across the agent
backends, the planner skill, the run command, the converter's fallback
logic, the MCP overlay path, one outright-false claim in the README
(Anthropic prompt caching), and the OpenAI / OpenRouter / Copilot
integrations being either stubs that throw at spawn time or wrappers
around CLI commands whose current shape we haven't verified.

Phase 14 fixes all of them before v1 ships. The phase's commitment is
explicit: **at the end of Phase 14, a user can confidently assign any
step of a plan to `claude-code`, `cursor`, `codex`, `copilot`, or `api`
(with any of the three providers).** The four-agent + multi-provider
matrix becomes a real surface, not aspirational marketing.

This phase is sequenced **before** release polish (now Phase 15) because
polish is wasted effort on top of a broken integration matrix — the
quickstart in `examples/`, the `yaao doctor` audit, and the README's
"backend support tiers" all rely on the integrations actually working.
Concurrent runs (Phase 16) and everything beyond also benefit from a
config-honoring, all-providers-functional engine first.

## Features

| Feature | Description | Doc |
| --- | --- | --- |
| **F14.1** | Enable-disable enforcement end-to-end (planner, converter, validate, run, MCP) | [F14.1-enable-disable-enforcement.md](F14.1-enable-disable-enforcement.md) |
| **F14.2** | Per-spawn MCP overlays for Cursor / Codex / Copilot | [F14.2-per-spawn-mcp-overlays.md](F14.2-per-spawn-mcp-overlays.md) |
| **F14.3** | API provider truth-up (Anthropic prompt caching, OpenAI/OpenRouter stub gating) | [F14.3-api-provider-truthup.md](F14.3-api-provider-truthup.md) |
| **F14.4** | Live backend smoke tests (Cursor / Codex / Copilot / Anthropic / OpenAI / OpenRouter) | [F14.4-live-backend-smoke-tests.md](F14.4-live-backend-smoke-tests.md) |
| **F14.5** | Spec Kit parser hardening + content propagation | [F14.5-speckit-hardening.md](F14.5-speckit-hardening.md) |
| **F14.6** | OpenAI + OpenRouter provider implementations (replace the stubs with working impls) | [F14.6-openai-openrouter-providers.md](F14.6-openai-openrouter-providers.md) |
| **F14.7** | Copilot backend reality check + working implementation | [F14.7-copilot-backend-reality-check.md](F14.7-copilot-backend-reality-check.md) |
| **F14.8** | Config UX & model discovery (`plan.agent`/`plan.model`, dead-field cleanup, `merge.history: rebase` default, `yaao agents --models`, `$schema` URL fix, "exited -1" fix) | [F14.8-config-ux-and-model-discovery.md](F14.8-config-ux-and-model-discovery.md) |
| **F14.9** | Base-branch auto-detection at init + validation at run, and `--feature-branch` CLI flag plumbed across plan/convert/run with documented override semantics | [F14.9-base-branch-detection-and-feature-branch-flag.md](F14.9-base-branch-detection-and-feature-branch-flag.md) |

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
- **OpenAI and OpenRouter providers are stubs that throw at spawn
  time.** `api` is one of the five integrations yaao claims to support,
  but two-thirds of its provider surface is unimplemented. Anthropic
  alone isn't "the API backend works."
- **Copilot's CLI surface is unverified.** [src/agents/copilot.ts](../../src/agents/copilot.ts)
  uses `gh copilot agent run`, but `gh copilot` historically exposed
  shell-suggestion commands, not an agentic runner. Whether the
  agentic command exists in the shipped `gh-copilot` extension is an
  open question that F14.7 closes — either by aligning to the real
  command, by pivoting to a REST integration, or by documenting
  Copilot as a v2 deferral.
- **The config block is full of small papercuts.** Dead fields
  (`plan.speckit` is in the schema but no code reads it), undocumented
  flags (`ctx-sys.auto-spawn` has zero inline comment),
  wrong-by-default settings (`merge.history: 'merge'` when the
  intended trio is `auto / agent / rebase`), no way to specify a
  separate planner agent + model without overriding global defaults,
  and a `$schema` URL pointing at a domain that doesn't exist
  (`yaao.dev`) so editor autocomplete silently fails. F14.8 sweeps all
  of these.
- **Model naming has no discovery surface.** `model: 'opus'` works
  only on `claude-code` (via an alias map in that backend's source);
  there's no way to ask yaao "what models can I use on `cursor` /
  `codex` / `copilot` / `api/openrouter`?" without reading vendor
  docs. The current `yaao agents` output's "✘ codex — codex --version
  exited -1" rendering is also misleading — the binary isn't on PATH,
  there's no exit code to report — and F14.8 closes all three threads
  with `yaao agents --models`, a per-backend static catalog, and the
  spawn-failure rendering fix.
- **Base-branch is hard-coded to `main` through the whole stack.**
  Schema, init scaffold, plan resolution, branch policy — all assume
  `main`. A repo using `master` fails at worktree creation with a
  cryptic `git rev-parse --verify` error, no detection, no suggestion.
  Every sufficiently old GitHub repo hits this on first `yaao run`.
  And the CLI surface is asymmetric with the MCP one: `yaao_convert`
  and `yaao_run` already take a `featureBranch` argument, but
  `yaao plan` / `yaao convert` / `yaao run` have no CLI flag for it.
  F14.9 closes both — detection at init, validation at run, and
  `--feature-branch` plumbed across the three commands with
  documented precedence.

## Implementation order

1. **F14.1** first. Closes the user-visible bug end-to-end. Three small
   PRs would also work (planner input + run-time gate + converter
   fallback) but they're small enough to land together.
2. **F14.2** second. Mechanical change per backend; the contract is
   identical to ClaudeCodeBackend's MCP overlay. Without this, ctx-sys
   integration (Phase 7) is silently broken for three of four agents
   and the Phase 16 concurrent-runs story has a gap.
3. **F14.3** third. Smaller scope: add Anthropic caching markers; add
   the validation rule for stub providers (which F14.6 then makes
   unreachable).
4. **F14.6** fourth. Ship the OpenAI and OpenRouter provider
   implementations so `provider: openai` and `provider: openrouter`
   work for real. Removes F14.3's `YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED`
   rule in the same PR.
5. **F14.7** fifth. Stage 1 (discovery) is small and quick — confirm
   what `gh-copilot` actually ships today. Stage 2 commits to one of
   three paths (align CLI / REST pivot / document as deferred). If the
   outcome is "deferred," F14.7 still ships honest validation and
   docs, and Phase 14's promise becomes "four of five integrations
   work confidently; Copilot is documented v2 work."
6. **F14.4** sixth. Backstops the rest of the phase. Live smoke tests
   prove F14.1, F14.2, F14.6, and F14.7 actually work against real
   CLIs/APIs, not just our parsers' assumptions about them.
7. **F14.8** seventh. Depends on F14.1 (planner config-awareness) and
   F14.6 (api backend usable for planning). Bundles the config-block
   cleanup, the model-discovery surface, and the `$schema` URL fix.
8. **F14.9** eighth. Independent of F14.8 — touches init.ts,
   runner.ts, git.ts, and the three CLI commands rather than the
   config schema. Could land in parallel with F14.8 if reviewers want
   smaller PRs.
9. **F14.5** last. Lowest-impact of the nine; surfaces today's silent
   Spec Kit parser failures and propagates `spec.md`/`plan.md`
   content that's currently dropped on the floor.

## Out of scope

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
- **Anthropic Bedrock / Vertex / other deployments.** F14.6 ships
  OpenAI and OpenRouter. Additional Anthropic deployments are separate
  providers and not phase-blocking.
- **Streaming responses across the API providers.** All three use the
  non-streaming completion shape today. The tool-use loop is
  round-trip based; streaming saves wall-clock only on the final
  assistant turn. v2 candidate.
- **Vision / image input** on any provider. Tools-only for v1.
