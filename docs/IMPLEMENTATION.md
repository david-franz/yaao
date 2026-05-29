# Implementation Plan

This document is the working spec for `yaao`, organized by phase. Each feature has a detailed specification in its own file under `phase-N/`.

## Overview

yaao is implemented in 18 phases, progressing from foundational CLI infrastructure through the execution engine, agent integrations, the planner/converter skills, the TUI, the MCP server, the web viewer, integration correctness, release polish, concurrent-run hardening + context-handoff enrichment, session-to-skill distillation, and finally npm distribution + the docs site.

> **Architectural keystone — MCP-first agent compatibility.** The integration story across Claude Code, Cursor, Copilot, Codex, and raw API models is built around yaao itself being an MCP server. Per-agent files are *thin* — each agent only needs to register yaao's MCP server. Skills, tool definitions, and prompts live behind the MCP boundary, not duplicated four ways. This means **Phase 12 (yaao-as-MCP) is foundational, not auxiliary**, and is intended to be implemented in parallel with Phase 8 (skills system). Phase 8's emitters write MCP-config bootstraps, not large skill artifacts. See the Implementation Priority section.

| Phase | Focus | Features | Status |
|-------|-------|----------|--------|
| 1  | Foundation                  | Project setup, CLI, config, init command, logging               | Shipped |
| 2  | Plan schema & validation    | Zod schema, YAML parser, DAG validation, `validate`             | Shipped |
| 3  | Worktree & git engine       | Worktree manager, branch graph, git wrapper, run journal        | Shipped |
| 4  | Agent backends              | Backend interface + Claude Code, Cursor, Copilot, Codex, API    | Shipped |
| 5  | Execution engine            | Scheduler, lifecycle, event bus, `run`, resume, dry-run         | Shipped |
| 6  | Merge engine                | Topological merge, manual/auto/agent conflict modes, PR mode    | Shipped |
| 7  | ctx-sys integration         | Detection, auto-spawn, MCP injection, query enforcement         | Shipped (yaao-side; runtime gated on ctx-sys 2.0 F1.3) |
| 8  | Skills system               | Source-of-truth format, per-agent emitters, `skills install`    | Shipped |
| 9  | yaao-planner skill          | Plan generation (markdown + Spec Kit), `plan` command           | Shipped |
| 10 | yaao-converter skill        | Plan → execution-plan compiler, `convert` command               | Shipped |
| 11 | TUI                         | Ink primitives, DAG renderer, `view`, live monitor, streaming   | Shipped (text-mode) |
| 12 | yaao-as-MCP                 | MCP server exposing `generate_plan`, `convert_plan`, `run_plan` | Shipped |
| 13 | Web viewer | HTTP+SSE server, DAG view, live run view, workspace, plan + config editors | Shipped |
| 14 | Integration correctness     | Enable-disable enforcement end-to-end, per-spawn MCP overlays for Cursor/Codex/Copilot, Anthropic prompt caching, OpenAI + OpenRouter provider implementations, Copilot backend reality check, live backend smoke tests for every backend, Spec Kit hardening, config UX + model discovery (`plan.agent`/`plan.model`, `yaao agents --models`, `$schema` URL fix, dead-field cleanup, `merge.history: rebase` default, "exited -1" rendering fix), base-branch auto-detection + `--feature-branch` CLI plumbing, `yaao skills import` from claude/cursor/copilot/codex/generic formats — at the end, every documented integration (claude-code / cursor / codex / copilot / api with all three providers) works confidently, the config block is honest about what's actually wired up, master-default repos work as smoothly as main-default ones, and the user's existing single-provider skill library becomes cross-provider via MCP | Shipped |
| 15 | Release polish              | `yaao doctor` (incl. orphan-run detection), `yaao init --mcp`, quickstart + examples, help-text + error audit, README truth-up + every-markdown-link-resolves regression test | Shipped |
| 16 | Concurrent runs & context handoff | runId entropy, branch namespacing, concurrency-model docs + tests, `context.md` enrichment (prompt, validation, commits, diff) | Planned |
| 17 | Session → Skill distillation | `yaao-distiller` skill, session readers, `yaao_distill` MCP tool, refinement | Planned |
| 18 | Distribution                | npm publish, docs site | Planned |

---

## Phase 1: Foundation **(shipped)**

Sets up the TypeScript project, CLI skeleton, configuration system, and the `init` command. Everything else builds on this.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F1.1** | Project setup & build pipeline                | shipped | [F1.1-project-setup.md](phase-1/F1.1-project-setup.md) |
| **F1.2** | CLI skeleton & command registry               | shipped | [F1.2-cli-skeleton.md](phase-1/F1.2-cli-skeleton.md) |
| **F1.3** | Configuration system (`yaao.config.json`)     | shipped | [F1.3-config-system.md](phase-1/F1.3-config-system.md) |
| **F1.4** | `yaao init` command                           | shipped | [F1.4-init-command.md](phase-1/F1.4-init-command.md) |
| **F1.5** | Logging & error handling                      | shipped | [F1.5-logging-errors.md](phase-1/F1.5-logging-errors.md) |

**Key Deliverables:**
- TypeScript + Node ≥ 20 + ESM project, bundled with `tsup`, tested with `vitest`.
- `commander`-based CLI with stub commands for the full surface area.
- Layered config: defaults → global (`~/.yaao/config.json`) → project (`.yaao/yaao.config.json`) → secrets (`.yaao/secrets.local.json`) → env-var expansion.
- `yaao init` scaffolds `.yaao/`, writes `yaao.config.json`, `.yaaoignore`, updates `.gitignore`.
- Structured logger with levels, JSON-or-text output, and a typed error hierarchy.

---

## Phase 2: Plan Schema & Validation **(shipped)**

The execution-plan schema is the lingua franca that connects the planner, converter, scheduler, and viewer. This phase pins it down.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F2.1** | Execution-plan schema (Zod + JSON Schema)     | shipped | [F2.1-execution-plan-schema.md](phase-2/F2.1-execution-plan-schema.md) |
| **F2.2** | YAML parser & loader                          | shipped | [F2.2-yaml-parser.md](phase-2/F2.2-yaml-parser.md) |
| **F2.3** | DAG validation (cycles, missing refs, fan-out)| shipped | [F2.3-dag-validation.md](phase-2/F2.3-dag-validation.md) |
| **F2.4** | `yaao validate` command                       | shipped | [F2.4-validate-command.md](phase-2/F2.4-validate-command.md) |

**Key Deliverables:**
- Single canonical Zod schema for execution plans; `.json-schema` artifact emitted for editor IntelliSense.
- YAML loader supporting `include` for sub-plans, with cycle detection across files.
- DAG validator: cycles, missing dependency IDs, duplicate task IDs, fan-out limits, agent/model availability.
- `yaao validate` returns non-zero on invalid plans with precise error locations (file/line/column).

---

## Phase 3: Worktree & Git Engine **(shipped)**

The mechanical layer that lets multiple agents work on the same repo at once without colliding.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F3.1** | Worktree manager                            | shipped | [F3.1-worktree-manager.md](phase-3/F3.1-worktree-manager.md) |
| **F3.2** | Dependency-aware branch graph               | shipped | [F3.2-branch-graph.md](phase-3/F3.2-branch-graph.md) |
| **F3.3** | Git operations wrapper                      | shipped | [F3.3-git-wrapper.md](phase-3/F3.3-git-wrapper.md) |
| **F3.4** | Run state journal                           | shipped | [F3.4-run-journal.md](phase-3/F3.4-run-journal.md) |

**Key Deliverables:**
- Per-task worktree creation/teardown under `.yaao/worktrees/<run-id>/<task-id>/`.
- Dependent tasks branch off the parent's branch (not `main`); diamond DAGs merge multiple parents into the worktree before launch.
- Thin, typed wrapper around `git` (via `execa`) covering worktree, branch, merge, status, push, fetch.
- Append-only run journal at `.yaao/runs/<run-id>.json` enabling crash-resume.

---

## Phase 4: Agent Backends **(shipped)**

A uniform `AgentBackend` interface plus an implementation for every supported agent in the v1 release.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F4.1** | `AgentBackend` interface                    | shipped | [F4.1-agent-backend-interface.md](phase-4/F4.1-agent-backend-interface.md) |
| **F4.2** | Claude Code backend                         | shipped | [F4.2-claude-code-backend.md](phase-4/F4.2-claude-code-backend.md) |
| **F4.3** | Cursor backend                              | shipped | [F4.3-cursor-backend.md](phase-4/F4.3-cursor-backend.md) |
| **F4.4** | GitHub Copilot backend                      | shipped | [F4.4-copilot-backend.md](phase-4/F4.4-copilot-backend.md) |
| **F4.5** | Codex backend                               | shipped | [F4.5-codex-backend.md](phase-4/F4.5-codex-backend.md) |
| **F4.6** | API backend (Anthropic / OpenAI / OpenRouter)| shipped (loop + sandbox; provider SDKs are stubs) | [F4.6-api-backend.md](phase-4/F4.6-api-backend.md) |
| **F4.7** | Backend detection & `yaao agents`           | shipped | [F4.7-backend-detection.md](phase-4/F4.7-backend-detection.md) |

**Key Deliverables:**
- One interface: `name`, `isAvailable()`, `spawn(options) → AgentProcess { pid, completed, cancel, output$ }`.
- Each CLI-based backend invokes the agent in non-interactive print mode, captures stdout/stderr, surfaces them as a streaming output observable.
- API backend uses provider SDKs with tool-use loop; supports prompt caching where available.
- `yaao agents` lists all backends with availability and version detection, via the `doctor`-shared probe layer.

---

## Phase 5: Execution Engine **(shipped)**

The brain. Walks the DAG, runs ready tasks within a parallelism budget, passes context between dependent tasks, persists state.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F5.1** | DAG scheduler                               | shipped | [F5.1-dag-scheduler.md](phase-5/F5.1-dag-scheduler.md) |
| **F5.2** | Task lifecycle & event bus                  | shipped | [F5.2-task-lifecycle.md](phase-5/F5.2-task-lifecycle.md) |
| **F5.3** | Context passing between tasks               | shipped | [F5.3-context-passing.md](phase-5/F5.3-context-passing.md) |
| **F5.4** | `yaao run` command                          | shipped | [F5.4-run-command.md](phase-5/F5.4-run-command.md) |
| **F5.5** | Resume, `--only`, `--skip`, `--dry-run`, `--trial` | shipped | [F5.5-run-modes.md](phase-5/F5.5-run-modes.md) |

**Key Deliverables:**
- Topological scheduler: tracks pending → ready → active → completed/failed/skipped, respects `max-parallel`.
- `eventemitter3` event bus emitting `task:queued`, `task:running`, `task:output`, `task:completed`, `task:failed`, `run:complete`, `run:failed`.
- Completed tasks surface a `context.md` artifact (last N lines of agent output + diff summary) that's auto-appended to dependents' prompts.
- `yaao run` orchestrates everything, including ctx-sys spawn, TUI launch, and signal handling for graceful shutdown.
- `--resume` replays the run journal; `--only` / `--skip` filter the DAG; `--dry-run` walks the DAG without spawning agents.

---

## Phase 6: Merge Engine **(shipped)**

How completed worktrees come back together — and what happens when they collide.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F6.1** | Topological merge orchestration             | shipped | [F6.1-merge-orchestration.md](phase-6/F6.1-merge-orchestration.md) |
| **F6.2** | Auto / manual / agent conflict modes        | shipped | [F6.2-conflict-modes.md](phase-6/F6.2-conflict-modes.md) |
| **F6.3** | PR merge mode (`gh pr create`)              | shipped | [F6.3-pr-mode.md](phase-6/F6.3-pr-mode.md) |
| **F6.4** | `yaao merge` & `yaao clean`                 | shipped | [F6.4-merge-clean-commands.md](phase-6/F6.4-merge-clean-commands.md) |

**Key Deliverables:**
- Merge happens in topological order to minimize conflicts; a trial-merge probe detects conflicts before committing.
- Default conflict mode is `manual`: yaao halts, points at the conflict markers, and waits for the human.
- `agent` mode (opt-in) spawns a configured resolver agent against the conflicted files; output is verified with `git diff --check` before committing.
- `auto` only ever commits a clean merge; refuses to silently resolve markers.
- Per-task `merge: pr` pushes the branch and creates a PR via `gh pr create`, with auto-generated title/body and idempotency.
- `yaao clean` tears down worktrees and (optionally) branches; refuses to clean unmerged work without `--force`.

---

## Phase 7: ctx-sys Integration (optional) **(shipped, yaao-side)**

Make ctx-sys a first-class context provider for any agent yaao runs, **but completely optional**. yaao never depends on ctx-sys, never installs it, and ships with `ctx-sys.enabled: false` in the default config. When the user opts in, the integration is proactive — not lazy or deferred.

> **Runtime status.** Auto-spawn calls `ctx-sys serve --socket <path>` and waits for a `ready` log line — both part of the contract being formalized in ctx-sys 2.0 ([F1.3](../../ctx-sys/docs/v2/phase-1/F1.3-yaao-native-integration.md)). Until ctx-sys 2.0 ships, the `ctx-sys.enabled: true` path errors at first task spawn (commander rejects the unknown `--socket` flag and the spawn times out waiting for ready). The default config (`enabled: false`) is unaffected.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F7.1** | Detection & auto-spawn (when enabled)       | shipped | [F7.1-detect-and-spawn.md](phase-7/F7.1-detect-and-spawn.md) |
| **F7.2** | MCP server registration (ctx-sys + user MCPs) | shipped | [F7.2-mcp-injection.md](phase-7/F7.2-mcp-injection.md) |
| **F7.3** | System-prompt directive (advisory)          | shipped | [F7.3-query-enforcement.md](phase-7/F7.3-query-enforcement.md) |
| **F7.4** | Optional git-hook impact reports            | removed | [F7.4-impact-hook.md](phase-7/F7.4-impact-hook.md) |

**Key Deliverables:**
- Default-off in `yaao.config.json`. When `ctx-sys.enabled: true`, yaao detects whether `ctx-sys serve` is running and (if `auto-spawn: true`) spawns it for the run.
- Generic MCP-server registration: ctx-sys is one entry; users can add other MCP servers via `mcp-servers:` and they flow through the same injection path.
- Every step gets an advisory system-prompt directive recommending `context_query` before writing code. **No hard enforcement** — agents decide whether to query.
- ~~Optional: install a git pre-commit hook that calls `ctx-sys hooks.impact_report` and feeds the result to merge-time conflict-resolution agents.~~ **Removed** — ctx-sys 2.0 cut the `hooks impact-report` command; the impact-on-demand role is now served by the advisory `context_query` directive above. See [F7.4](phase-7/F7.4-impact-hook.md).

---

## Phase 8: Skills System (MCP-first) **(shipped)**

One source-of-truth skill. The skill is exposed primarily as a yaao MCP tool (`yaao_skill_<name>`) — see Phase 12. The per-agent emitters write *small* MCP-config bootstraps and short instruction stubs that point agents at yaao's MCP server, not large duplicated skill artifacts.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F8.1** | Skill source-of-truth format                | shipped | [F8.1-skill-format.md](phase-8/F8.1-skill-format.md) |
| **F8.2** | Claude Code emitter (MCP config + stub)     | shipped | [F8.2-claude-code-emitter.md](phase-8/F8.2-claude-code-emitter.md) |
| **F8.3** | Cursor emitter (MCP config + stub)          | shipped | [F8.3-cursor-emitter.md](phase-8/F8.3-cursor-emitter.md) |
| **F8.4** | Copilot emitter (MCP config + stub)         | shipped | [F8.4-copilot-emitter.md](phase-8/F8.4-copilot-emitter.md) |
| **F8.5** | Codex emitter (MCP config + stub)           | shipped | [F8.5-codex-emitter.md](phase-8/F8.5-codex-emitter.md) |
| **F8.6** | `yaao skills install` / sync                | shipped | [F8.6-skills-install.md](phase-8/F8.6-skills-install.md) |

**Key Deliverables:**

- `.yaao/skills/<name>/skill.yaml` (metadata + inputs + applies-to) + `prompt.md` (body) as the source of truth.
- Each skill is auto-registered as a yaao MCP tool `yaao_skill_<name>` (Phase 12 wires this).
- Per-agent emitters write **MCP-config bootstraps**: `.claude/yaao-mcp.json`, managed blocks in `.cursor/mcp.json` / `~/.codex/config.toml`, and short instruction stubs (`AGENTS.md`, `CLAUDE.md`, `copilot-instructions.md`) that say "yaao's MCP tools are available; use `yaao_skill_<name>` for X."
- Inline-prompt fallback only for agents with weak MCP coverage (e.g. early Copilot builds), as a safety net not the default path.
- Generated files include a `# Managed by yaao` header + hash; manual edits are detected and surfaced.

---

## Phase 9: yaao-planner Skill **(shipped)**

The skill that authors implementation plans, plus the CLI driver that invokes it.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F9.1** | Skill design (system prompt, tools, guard-rails) | shipped | [F9.1-planner-skill.md](phase-9/F9.1-planner-skill.md) |
| **F9.2** | Markdown plan format & template             | shipped | [F9.2-markdown-format.md](phase-9/F9.2-markdown-format.md) |
| **F9.3** | Spec Kit format support                     | shipped | [F9.3-speckit-format.md](phase-9/F9.3-speckit-format.md) |
| **F9.4** | Feature vs project scope                    | shipped | [F9.4-scope-modes.md](phase-9/F9.4-scope-modes.md) |
| **F9.5** | `yaao plan` command                         | shipped | [F9.5-plan-command.md](phase-9/F9.5-plan-command.md) |

**Key Deliverables:**
- `yaao-planner` skill: knows the markdown convention, the Spec Kit triplet, when to break a plan into multiple files, and is required to call `context_query` first if ctx-sys is enabled.
- Markdown convention: numbered phase headings, task tables with `id`/`depends`/`agent` hints, fenced YAML for explicit step config.
- Spec Kit format: emits compatible `spec.md` + `plan.md` + `tasks.md`.
- `--scope feature` produces a single plan file; `--scope project` produces a multi-phase, multi-directory plan.
- `yaao plan` drives the user's default agent (or `--agent`) to run the skill; output is written to `.yaao/plans/`.

---

## Phase 10: yaao-converter Skill **(shipped)**

Turns any implementation plan (yaao-authored or not) into a schema-valid execution plan with best-effort dependency inference.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F10.1** | Skill design                               | shipped | [F10.1-converter-skill.md](phase-10/F10.1-converter-skill.md) |
| **F10.2** | Markdown plan parser                       | shipped | [F10.2-markdown-parser.md](phase-10/F10.2-markdown-parser.md) |
| **F10.3** | Spec Kit plan parser                       | shipped | [F10.3-speckit-parser.md](phase-10/F10.3-speckit-parser.md) |
| **F10.4** | Dependency inference                       | shipped | [F10.4-dependency-inference.md](phase-10/F10.4-dependency-inference.md) |
| **F10.5** | Default agent assignment                   | shipped | [F10.5-agent-assignment.md](phase-10/F10.5-agent-assignment.md) |
| **F10.6** | `yaao convert` command                     | shipped | [F10.6-convert-command.md](phase-10/F10.6-convert-command.md) |

**Key Deliverables:**
- `yaao-converter` skill: deterministic schema-validated YAML output, infers missing fields, asks for clarification when ambiguous.
- Markdown parser using `remark` extracts tasks, prose, and embedded fenced YAML.
- Spec Kit parser maps `tasks.md` items to execution-plan tasks 1:1.
- Dependency inference: phase ordering + textual cues ("after X exists", "depends on Y") → explicit `depends:` arrays. User can review/override before running.
- Default agent assignment heuristic based on task tags: tests → opinionated agent, UI → opinionated agent, infra → opinionated agent (configurable in `yaao.config.json`).
- `--split` emits one execution-plan file per phase plus a top-level plan with `include:` references.

---

## Phase 11: TUI **(shipped — text-mode)**

Static plan viewer, live execution monitor, and the rendering primitives behind both. We ship a text-mode renderer (pure functions producing styled lines) rather than the Ink-based interactive TUI the spec described; an Ink presentation layer can drop in on top of these primitives later.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F11.1** | Rendering primitives & DAG renderer       | shipped (text-mode) | [F11.1-ink-primitives.md](phase-11/F11.1-ink-primitives.md) |
| **F11.2** | `yaao view` (static)                       | shipped | [F11.2-view-command.md](phase-11/F11.2-view-command.md) |
| **F11.3** | `yaao run` live monitor                    | shipped (via `yaao status --watch`) | [F11.3-run-monitor.md](phase-11/F11.3-run-monitor.md) |
| **F11.4** | Agent output streaming                     | shipped (per-task output.log) | [F11.4-output-streaming.md](phase-11/F11.4-output-streaming.md) |
| **F11.5** | `yaao status` command                      | shipped | [F11.5-status-command.md](phase-11/F11.5-status-command.md) |

**Key Deliverables:**
- Shared rendering primitives: status table, DAG layout (Sugiyama-style with width caps), log pane, key-help footer.
- `yaao view` opens the plan in static mode: DAG, per-task panel, parallelism width.
- `yaao run` opens the live monitor: task table + log pane, keybindings (`↑↓ enter q r`), cancellable in-flight tasks.
- Real-time agent output streamed via the backend's `output$` observable, not buffered until the task ends.
- `yaao status [run-id]` prints the run's task table for a finished run; with `--watch` it tails an in-flight run.

---

## Phase 12: yaao-as-MCP (primary integration surface) **(shipped)**

Expose yaao itself as an MCP server. **This is the canonical way every agent — Claude Code, Cursor, Copilot, Codex, raw API — drives yaao.** Build alongside Phase 8: the skills emitters generate MCP bootstraps that point at this server. Shipped over stdio; `--socket` and `--http` transports are post-MVP additions on the same tool surface.

| Feature | Description | Status | Doc |
|---------|-------------|--------|-----|
| **F12.1** | MCP server scaffold + transport            | shipped (stdio) | [F12.1-mcp-server.md](phase-12/F12.1-mcp-server.md) |
| **F12.2** | `yaao_plan` tool                           | shipped | [F12.2-generate-plan-tool.md](phase-12/F12.2-generate-plan-tool.md) |
| **F12.3** | `yaao_convert` tool                        | shipped | [F12.3-convert-plan-tool.md](phase-12/F12.3-convert-plan-tool.md) |
| **F12.4** | `yaao_run` & `yaao_status` tools           | shipped | [F12.4-run-plan-tool.md](phase-12/F12.4-run-plan-tool.md) |
| **F12.5** | Skill-as-MCP-tool exposure                 | shipped | [F12.5-skill-tools.md](phase-12/F12.5-skill-tools.md) |
| **F12.6** | Skill hot reload (fs.watch + reconcile)    | shipped | [F12.6-skill-hot-reload.md](phase-12/F12.6-skill-hot-reload.md) |

**Key Deliverables:**

- `yaao serve` exposes an MCP server over stdio. Spawned by AI clients (Claude Code, Cursor, Copilot, Codex), not directly by humans. The HTTP+SSE viewer lives separately as `yaao web` (Phase 13).
- `yaao_plan` mirrors `yaao plan`; returns the plan body plus the path written.
- `yaao_convert` mirrors `yaao convert`; returns YAML and validates.
- `yaao_run` starts a run asynchronously; `yaao_status` reports live state. Long-running progress flows via MCP progress notifications.
- Every user-defined skill in `.yaao/skills/` is auto-registered as `yaao_skill_<name>` with input schema derived from `skill.yaml` (F12.5). A debounced FS watcher keeps the catalog in sync mid-session: adding or removing a skill directory triggers register/remove + `tools/list_changed` within ~250 ms, no reconnect needed (F12.6). This is what makes the Phase 17 distiller's "callable in the next turn" UX work.

---

## Phase 13: Web Viewer **(shipped)**

The browser surface for everything that isn't actually starting a run. Run launching stays with the CLI / MCP (`yaao_run`, `yaao_resume`); the web viewer is where you point a browser to watch a run happen, browse history, manage workspace state, and edit plans and config.

| Feature | Description | Status | Doc |
| --- | --- | --- | --- |
| **F13.0** | Scaffold: `yaao web` CLI command, hono listener, `web/` workspace, build pipeline, smoke tests | shipped | [F13.0-scaffold.md](phase-13/F13.0-scaffold.md) |
| **F13.1** | `yaao web` HTTP+SSE server | shipped | [F13.1-web-server.md](phase-13/F13.1-web-server.md) |
| **F13.2** | DAG view with live-reload | shipped | [F13.2-web-dag-view.md](phase-13/F13.2-web-dag-view.md) |
| **F13.3** | Live run view + activity stream | shipped | [F13.3-web-run-view.md](phase-13/F13.3-web-run-view.md) |
| **F13.4** | Workspace page (yaao_inspect + yaao_prune) | shipped | [F13.4-web-workspace-view.md](phase-13/F13.4-web-workspace-view.md) |
| **F13.5** | Plan editor (textarea + live DAG preview) | shipped (textarea v1) | [F13.5-web-plan-editor.md](phase-13/F13.5-web-plan-editor.md) |
| **F13.6** | Config editor (form + raw, secrets-aware) | shipped | [F13.6-web-config-editor.md](phase-13/F13.6-web-config-editor.md) |

**Key Deliverables:**

- `yaao web` is a separate process from F12.1's `yaao serve` MCP stdio server — AI clients spawn `yaao serve`, humans run `yaao web` from a terminal. They share state through the filesystem, not in-process: every process runs F12.6's FS watcher, and the journal (`.yaao/runs/<id>/journal.jsonl`) is the cross-process event channel. A run started by Claude Code via `yaao_run` is watchable in the web viewer in real time via journal tail. Defaults to `127.0.0.1` with no auth; non-loopback binds require `--token`.
- **Run creation is deliberately not in the API.** Start a run from your terminal (`yaao run`) or your MCP-aware editor (`yaao_run`); come to the web view to watch it. Keeping spawning in one place simplifies the lifecycle story and aligns the UI with how users actually work.
- **Activity stream, not log tail.** F13.3 forwards every `RunEvent` over SSE — `task:agent-event` (with `ev.type` ∈ `{stdout, stderr, thinking, tool-use}`), `task:retry-attempt`, `task:diff`, `task:committed`, `task:merged`, `task:failed`. The browser renders these as a unified stream with thinking blocks collapsed by default and tool-use calls one-line summarized. The validation outcome (`exitCode`, `decisionReason`) is rendered prominently on the task detail pane — the lifecycle records the verdict on `task:completed`, the web viewer makes it impossible to miss.
- **Workspace page** wraps `yaao_inspect` and `yaao_prune` so cleanup affordances live in the browser. Each prune action defaults to a dry-run preview; the apply call is a separate click. The structural safety rails (base-branch never deleted, worktrees with uncommitted changes require explicit force) carry through from the MCP tool.
- **Plan editor (F13.5)** ships as a pragmatic textarea-based v1 (no Monaco dep) with a split DAG pane that re-renders on debounced input via a lightweight client-side YAML preview parser. Save goes through `PUT /api/plans/:slug/raw`, which runs the full `validatePlan` pipeline server-side — schema-valid plans with dependency cycles are caught before write, so structural validity is always the server's verdict. Live-reload via `/api/plans/:slug/watch` cooperates with the user's IDE: edits in either place show up in the other; the editor surfaces a non-modal "file changed on disk" banner if there are unsaved changes locally.
- **Config editor (F13.6)** ships a form view for the common settings (defaults, merge, run gates, API providers) plus a raw JSON view; both edit the same buffer. Secrets handling is the load-bearing rule: the editor only ever shows `${ENV_VAR}` placeholders, never resolved values; `PUT /api/config/raw` runs the same literal-secret detector `loadConfig` uses and rejects any commit containing a literal API key. Config changes apply to new runs automatically (each process re-reads config on the next task spawn).

---

## Phase 14: Integration Correctness

The v1 pre-flight surfaced a load-bearing failure: disabling an agent in `yaao.config.json` doesn't actually disable it. A user who turned off `claude-code` and kept only `copilot` ran `yaao plan` and `yaao run`, and claude-code agents spawned anyway. The same audit caught six related defects: only Claude Code's backend reads per-spawn MCP server config (so ctx-sys and `context.mcp-servers:` are silently dropped for Cursor/Codex/Copilot); Anthropic prompt caching is claimed in the README but no `cache_control` markers are emitted; OpenAI and OpenRouter are 6-line stubs that throw at spawn time; the Copilot backend wraps `gh copilot agent run` which may not even exist in the current `gh-copilot` extension; non-Claude backends have argv-only test coverage; and the Spec Kit parser silently emits zero tasks on slightly-off input while dropping `spec.md`/`plan.md` content. Phase 14 fixes all of them. The phase's commitment is explicit: **at the end of Phase 14, a user can confidently assign any step of a plan to `claude-code`, `cursor`, `codex`, `copilot`, or `api` (with any of `anthropic` / `openai` / `openrouter`).** See [phase-14/PHASE-14.md](phase-14/PHASE-14.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F14.1** | Enable-disable enforcement end-to-end (planner, converter, validate, run, MCP) | [F14.1-enable-disable-enforcement.md](phase-14/F14.1-enable-disable-enforcement.md) |
| **F14.2** | Per-spawn MCP overlays for Cursor / Codex / Copilot | [F14.2-per-spawn-mcp-overlays.md](phase-14/F14.2-per-spawn-mcp-overlays.md) |
| **F14.3** | API provider truth-up (Anthropic prompt caching + OpenAI/OpenRouter stub validation) | [F14.3-api-provider-truthup.md](phase-14/F14.3-api-provider-truthup.md) |
| **F14.4** | Live backend smoke tests (Cursor / Codex / Copilot / Anthropic / OpenAI / OpenRouter) | [F14.4-live-backend-smoke-tests.md](phase-14/F14.4-live-backend-smoke-tests.md) |
| **F14.5** | Spec Kit parser hardening + content propagation | [F14.5-speckit-hardening.md](phase-14/F14.5-speckit-hardening.md) |
| **F14.6** | OpenAI + OpenRouter provider implementations (replace the stubs) | [F14.6-openai-openrouter-providers.md](phase-14/F14.6-openai-openrouter-providers.md) |
| **F14.7** | Copilot backend reality check + working implementation | [F14.7-copilot-backend-reality-check.md](phase-14/F14.7-copilot-backend-reality-check.md) |
| **F14.8** | Config UX & model discovery (plan.agent/plan.model, dead-field cleanup, merge.history rebase default, `yaao agents --models`, `$schema` URL fix, "exited -1" rendering fix) | [F14.8-config-ux-and-model-discovery.md](phase-14/F14.8-config-ux-and-model-discovery.md) |
| **F14.9** | Base-branch auto-detection at init + run-time validation, and `--feature-branch` CLI flag plumbed across plan/convert/run | [F14.9-base-branch-detection-and-feature-branch-flag.md](phase-14/F14.9-base-branch-detection-and-feature-branch-flag.md) |
| **F14.10** | `yaao skills import` — convert claude/cursor/copilot/codex/generic skill formats into yaao skills so any single-provider library becomes cross-provider via MCP | [F14.10-skills-import.md](phase-14/F14.10-skills-import.md) |

**Key Deliverables:**

- **Enable-disable contract honored across every yaao surface.** `yaao run` and `yaao_run` gate on a fresh `validatePlan` pass that blocks `YAAO_PLAN_AGENT_DISABLED` and the new `YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED`. `backendForTask` in both CLI and MCP refuses to construct a disabled backend (defense-in-depth). The planner skill gets a fifth input — `enabled-agents` — so its worked examples reflect the user's actual config instead of hard-coding `claude-code`. The converter's fallback walks the enabled list instead of demoting to `defaults.agent` blindly. `--allow-disabled-agents` is the escape hatch.
- **Per-spawn MCP overlays for Cursor/Codex/Copilot.** Each backend's `spawn()` writes a transient MCP config in the format its CLI accepts (`.cursor/mcp.json` overlay swap, per-run TOML for codex, per-run `.vscode/mcp.json` for copilot), points the CLI at it, restores the user's original on completion. Factored into a shared `src/agents/mcp-overlay.ts` helper. Closes the silent-drop of `context.mcp-servers:` and ctx-sys auto-spawn for three of four CLI agents.
- **Anthropic prompt caching shipped.** `cache_control: { type: 'ephemeral' }` on the system prompt, the tools-list tail, and the most recent tool-result block. `cache_creation_input_tokens` + `cache_read_input_tokens` accumulated per spawn and surfaced on `task:completed` so users can see hit rate in the journal + web viewer. F14.3 stages the validation rule for OpenAI/OpenRouter (`YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED`); F14.6 then removes that rule in the same PR as the real implementations land.
- **OpenAI + OpenRouter provider implementations.** Working `OpenAIProvider` against `POST /v1/chat/completions` with the tool-use loop (translating yaao's `ApiToolCall` / `ApiToolResult` shapes to OpenAI's `tool_calls` + `role: 'tool'` sequence). `OpenRouterProvider` reuses the OpenAI-compatible logic with a different default `baseUrl` and OpenRouter's attribution headers. Cache telemetry (`cached_tokens` for OpenAI) accumulates onto `task:completed` the same way Anthropic's does.
- **Copilot backend reality check.** Stage 1 confirms what `gh-copilot` actually ships today (does `gh copilot agent run` exist? is there a different agentic binary? a REST API?). Stage 2 commits to one of three paths: (a) align the backend's argv to the real CLI, (b) pivot to a `CopilotProvider` in the API backend backed by GitHub's REST + `gh auth token`, or (c) ship `YAAO_PLAN_AGENT_UNSUPPORTED_TODAY` validation and document Copilot as a v2 deferral. If the outcome is (c), Phase 14's promise becomes "four of five integrations work confidently; Copilot is documented v2 work" and the README matches.
- **Live backend smoke tests.** Skip-if-missing live spawn tests under `tests/phase-14/live/` for each CLI backend (claude-code, cursor, codex, copilot) plus each API provider (anthropic, openai, openrouter); recorded fixture parsers under `tests/phase-14/parser-fixtures/`. A new `live-backends` CI job runs the live tests on nightly cron + manual dispatch; PRs stay fast. Catches the "vendor shipped a CLI/API update that broke our parser" failure mode that argv-only tests miss.
- **Spec Kit hardening.** Strict task-line regex relaxed to accept common variants (single asterisks, en-dash, missing checkbox bullet); `YAAO_SPECKIT_PARSE_EMPTY` warning surfaces zero-tasks failures with a hint pointing at the expected shape. `spec.md` and `plan.md` bodies propagate through to the generated execution plan's new `plan.context` field and get inlined into per-task prompts (token-budgeted via `config.context.plan-context-budget`).
- **Config UX & model discovery.** New `plan.agent` / `plan.model` / `plan.api` config block so users can pin a planner backend separate from `defaults.agent`; the `yaao plan` "api backend not supported in MVP" throw is lifted (works because F14.6 ships the OpenAI/OpenRouter providers). Dead `plan.speckit` field removed. `merge.history` default flips from `merge` to `rebase` (the intended trio is `auto` / `agent` / `rebase`). `ctx-sys.auto-spawn`, `defaults.permissions: 'allow-all'`, and the `task.model → agents.X.default-model → defaults.model` resolution chain all get inline schema comments + README sections. `defaults.model: 'opus'` paired with a non-Claude `defaults.agent` produces `YAAO_PLAN_CLAUDE_ALIAS_ON_WRONG_AGENT` at validate. Workspace `mcp-servers` vs per-plan `context.mcp-servers` precedence documented + `YAAO_PLAN_MCP_SERVER_OVERRIDE` warning. **Static `KNOWN_MODELS` catalog per backend** (+ `KNOWN_MODELS_ASOF` date) surfaced via `yaao agents --models` (with `--json` / `--agent <name>`) and an MCP `yaao_models` tool, so users can answer "what can I pass for `model:` on cursor/codex/copilot/openrouter?" without reading vendor docs. The `yaao agents` "exited -1" rendering bug (when a backend binary isn't on PATH) is fixed in `SubprocessBackend.isAvailable` and the Copilot override — replaced with `binary '<bin>' not found on PATH`. The broken `$schema: https://yaao.dev/schema/config.json` URL is replaced with a working GitHub-raw URL pointing at [schema/config.schema.json](../schema/config.schema.json) until Phase 18 stands up `yaao.dev`.
- **Base-branch detection + `--feature-branch` CLI plumbing.** New `git.detectDefaultBranch(cwd)` primitive walks `git symbolic-ref refs/remotes/origin/HEAD` → `git config init.defaultBranch` → `'main'` fallback; `yaao init` calls it and writes the detected branch (logged to the user). New `--base-branch <name>` flag on `yaao init` lets the user pin explicitly. Runtime validation in `runner.ts` (and `yaao_run` MCP) emits `YAAO_BASE_BRANCH_MISSING` with an actionable hint when the plan's base-branch doesn't exist — no more cryptic git errors. `--feature-branch <name>` flag added to `yaao plan` (threads through into the generated plan's metadata), `yaao convert` (writes verbatim to `plan.featureBranch` in the YAML, matching the existing MCP `yaao_convert` shape), and `yaao run` (runtime override, empty string clears, matching the existing MCP `yaao_run` shape). Documented precedence: CLI flag > plan-file YAML > workspace `defaults.base-branch` > detected default (for base-branch); CLI flag > plan-file `plan.featureBranch` > absent (for feature-branch).
- **`yaao skills import` — cross-provider skill portability.** A new command that converts agent-native skill formats into yaao's portable format and registers them as `yaao_skill_<name>` MCP tools callable from every agent. Supported sources: Claude Code skills (`.claude/skills/<name>/SKILL.md` + frontmatter, sibling `tools/` directories copied verbatim), Cursor rules (`.cursor/rules/*.mdc` with YAML frontmatter, `globs` preserved as new optional `applies-to-files` field), Copilot custom instructions (`.github/copilot-instructions.md`), Codex `AGENTS.md`, and generic markdown-with-frontmatter as a catch-all. CLI: `yaao skills import [path]` auto-detects format; `--from <fmt>` is explicit; bulk via globs; `--scope project|user`, `--name`, `--dry-run`, `--force`, `--no-install`. Post-import runs `yaao skills install` automatically; F12.6's watcher fires `tools/list_changed` so the imported skill is callable in the same MCP session. Each imported skill carries an `Imported from <source-path> on <iso-date>` audit-trail footer in its `prompt.md`. Mirror MCP tool `yaao_skills_import`. Distinct from Phase 17 distillation (which captures *new* skills from finished sessions); F14.10 *imports* skills the user already has.
- **Implementation order**: **F14.1** first (closes the user-visible bug end-to-end), **F14.2** second (unblocks ctx-sys for non-Claude agents), **F14.3** third (stage the validation gate), **F14.6** fourth (ship OpenAI + OpenRouter, removing F14.3's gate in the same PR), **F14.7** fifth (Copilot reality check + commit to a path), **F14.4** sixth (live tests backstop F14.1/F14.2/F14.6/F14.7), **F14.8** seventh (config UX + model discovery; depends on F14.1's planner-config-awareness and F14.6's working api providers), **F14.9** eighth (independent — touches init.ts/runner.ts/git.ts and the three CLI commands; could land in parallel with F14.8), **F14.10** ninth (independent of every other F14.x — only depends on shipped F8.1/F8.6/F12.6; place in PR queue based on reviewer bandwidth), **F14.5** last (lowest impact, surfaces silent failures + propagates dropped content).

---

## Phase 15: Release Polish

The work that turns yaao from feature-complete into v1-shippable. Closes the first-use gaps (auto-MCP registration on `yaao init`, an environment-audit `yaao doctor`, a 60-second quickstart), audits error messages + their hints, and trues up the README to what the engine actually does. Sequenced after integration correctness (Phase 14) so the polish lands on top of an engine that actually honors its enable/disable contract — and ahead of concurrent-run hardening (Phase 16), distillation (Phase 17) and distribution (Phase 18) so polish lands before any of those branches off. See [phase-15/PHASE-15.md](phase-15/PHASE-15.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F15.1** | `yaao doctor` (subsumes `yaao agents`; orphan-run detection) | [F15.1-doctor.md](phase-15/F15.1-doctor.md) |
| **F15.2** | `yaao init --mcp` — auto-register yaao's MCP server in `.mcp.json` | [F15.2-init-mcp.md](phase-15/F15.2-init-mcp.md) |
| **F15.3** | First-use experience — 60-second quickstart + `examples/` directory | [F15.3-first-use.md](phase-15/F15.3-first-use.md) |
| **F15.4** | Help text & error message audit | [F15.4-help-and-errors.md](phase-15/F15.4-help-and-errors.md) |
| **F15.5** | README + IMPLEMENTATION.md accuracy pass | [F15.5-docs-truthup.md](phase-15/F15.5-docs-truthup.md) |

**Key Deliverables:**

- `yaao doctor` is the single command a confused user can run: Node version, git version, agent CLI presence + versions, ctx-sys presence + version, config sanity, write permissions, secrets-not-in-config rule, every enabled provider's API key resolves. Subsumes the per-agent availability check previously surfaced as `yaao agents`. **Also detects orphaned runs** — runs whose journal still says `running` but whose `runner.pid` is dead or whose journal mtime is stale — closing the "kill -9 left it stuck on running" gap that the CLI's SIGINT/SIGTERM handler (5a05f8c) doesn't cover. The same helper feeds `yaao_inspect`'s workspace listing so the web viewer's status pill stops lying.
- `yaao init` default-on writes a `yaao` entry to the project's `.mcp.json` (and the per-agent equivalents: `.cursor/mcp.json`, `~/.codex/config.toml`, an inline reference in `.github/copilot-instructions.md`). Preserves siblings, never silently overwrites an existing `yaao` entry that differs from what we'd write. `--no-mcp` opts out.
- A copy-pasteable five-line quickstart in the README — `npm i -g yaao && yaao init && yaao plan ... && yaao convert ... && yaao run ...` — works on a fresh machine because F15.1 + F15.2 close the previously-manual setup gap. Three real, runnable plans under `examples/` (TypeScript monorepo, Python service, C kernel) double as live tests of the convention.
- Every command's `--help` is at least one sentence beyond the bare verb (the pre-v1 audit listed concrete gaps for `yaao stop`, `yaao serve`, `yaao plan --scope`, `yaao web --no-open`, etc.) AND every user-facing `YaaoError` carries a `hint:` that points at the fix; stale hints (referencing renamed commands) are caught.
- The README + IMPLEMENTATION.md sweep closes accumulated drifts: API backend status (Anthropic shipped with prompt caching post-Phase 14, OpenAI/OpenRouter explicitly stubs surfaced at validate time), `yaao agents` retired into `yaao doctor`, `format: both` and `--scope project` either dropped or marked experimental, all phase-N references retargeted after this renumbering. Runs *last* in the phase so drift introduced by F15.1–F15.4 is caught in the same pass.
- End-to-end validation on real projects is deliberately **not** a Phase 15 feature — it's done out-of-band as part of v1 sign-off so the phase has a deterministic completion bar (every feature shipped + tested) rather than a human-time-dependent one.

---

## Phase 16: Concurrent Runs & Context Handoff

Two findings from the v1 pre-flight review motivate this phase. First, concurrent runs against distinct feature branches are *almost* supported by the engine (worktree paths isolate by runId; merges use git plumbing + atomic ref CAS) but two naming choices block the workflow: runIds use millisecond resolution and the default task branch is `${plan.name}/${task.id}` with no featureBranch namespace. Second, the parent→child context handoff is correct but lossy — dependents receive an 80-line stdout tail and a file list, but not the parent's task prompt, not the validation outcome, and only `--numstat` totals instead of a per-file diff shape. This phase ships both. See [phase-16/PHASE-16.md](phase-16/PHASE-16.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F16.1** | Concurrent-run isolation hardening (runId entropy + branch namespacing) | [F16.1-concurrent-run-isolation.md](phase-16/F16.1-concurrent-run-isolation.md) |
| **F16.2** | Concurrency model — docs alignment + integration tests | [F16.2-concurrency-model.md](phase-16/F16.2-concurrency-model.md) |
| **F16.3** | Context handoff enrichment (parent prompt, validation, commits, diff) | [F16.3-context-handoff.md](phase-16/F16.3-context-handoff.md) |

**Key Deliverables:**

- **runId entropy.** `run-${Date.now().toString(36)}-${nanoid(6)}` replaces the millisecond-only id everywhere (`src/cli/commands/run.ts`, `src/mcp/tools.ts`). Two MCP-driven `yaao_run` calls in the same tick get distinct ids. Forward-only — `--resume <oldRunId>` keeps working.
- **Default branch namespacing.** Task default branch becomes `${featureBranch}/${task.id}` when `plan.featureBranch` is set; falls back to the historical `${plan.name}/${task.id}` otherwise. Two concurrent runs of the same plan against distinct feature branches now have disjoint task-branch namespaces by construction.
- **Concurrency model documented + tested.** Removes the `.yaao/.lock` claim from Phase 12 docs (no such lock exists in `src/`, and we deliberately don't add it — concurrent runs are what we want). README gets a "Concurrent runs" section. Integration tests under `tests/phase-16/concurrent-runs/` prove two runs against distinct feature branches finish independently and don't trample the root checkout.
- **Context handoff enrichment.** `context.md` gains four bounded sections (toggleable via `config.context.include: […]`): the parent's resolved task prompt (first 30 lines), the validation outcome when present (command, exitCode, durationMs, decisionReason, mustPass), the full commit chain (`git log baseCommit..HEAD --format=- %h %s`), and a per-file `git diff --stat` (~30-line cap). All sit inside the existing per-dep token budget so the budgeting logic is unchanged.
- **F16.1 ships first.** Pure naming change, unblocks F16.2's integration tests. F16.2 follows. F16.3 is orthogonal and can land in parallel.

---

## Phase 17: Session → Skill Distillation

Close the missing half of the skill lifecycle: capture the patterns from a finished chat session — conventions, focus files, user corrections, the approach that actually worked — and crystallize them into a reusable yaao skill that immediately becomes available across every connected agent via the existing F8.1 format, F12.5 auto-MCP-registration, and F12.6 hot reload. See [phase-17/PHASE-17.md](phase-17/PHASE-17.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F17.1** | `yaao-distiller` built-in skill | [F17.1-distiller-skill.md](phase-17/F17.1-distiller-skill.md) |
| **F17.2** | In-session capture (`SessionRecord` contract, redaction) | [F17.2-session-readers.md](phase-17/F17.2-session-readers.md) |
| **F17.3** | Skill emission, validation, post-emit install | [F17.3-skill-emission.md](phase-17/F17.3-skill-emission.md) |
| **F17.4** | `yaao_distill` MCP tool (sole entry point) | [F17.4-distill-mcp-tool.md](phase-17/F17.4-distill-mcp-tool.md) |
| **F17.5** | Skill refinement (re-distill, diff review) | [F17.5-skill-refinement.md](phase-17/F17.5-skill-refinement.md) |

**Key Deliverables:**

- `yaao-distiller` joins `yaao-planner` and `yaao-converter` as a third built-in skill under `src/skills/builtin/`. Its prompt is the whole product: a three-stage pipeline (identify the generalizable task → split signal from instance → emit a draft `skill.yaml` + `prompt.md`) with explicit anti-leakage rules.
- **MCP is the only entry point.** Unlike every other yaao command, Phase 17 has no shell-CLI surface — distillation is inherently in-context, and the agent producing the `SessionRecord` is by definition the agent calling the tool. The calling agent supplies its own structured self-summary as the `session` argument; yaao never reads IDE-internal transcript stores. Works across every supported agent (Claude Code, Cursor, Copilot, Codex, raw API).
- `yaao_distill` writes to `.yaao/skills/<name>/` (project) or `~/.yaao/skills/<name>/` (user) and reuses `validateSkill` from F8.1. After write, `yaao skills install` re-emits per-agent stubs automatically. F12.6's hot reload picks up the new directory and the SDK fires `tools/list_changed` — so a skill distilled from a Claude Code session is callable from Cursor, Copilot, Codex, and the raw API in the next turn, with no reconnect.
- **F17.1, F17.2, and F17.3 land together** as one PR — the distiller prompt, the `SessionRecord` contract it consumes, and the emission pipeline it produces output for are deeply coupled and can't be sensibly built in isolation. F17.4 (MCP driver) and F17.5 (refinement) layer on top once those three are working end-to-end.
- Refinement (F17.5): re-run the distiller against an existing skill with a fresh session. The distiller merges (preserving anti-patterns and distillation notes); yaao returns a diff + changelog in the MCP response so the calling agent can show the user before committing (or call with `apply: false` for explicit preview). Contradictions between old and new conventions block auto-apply, detected via a **structural rule** over backtick-quoted identifiers shared between bullets (LLM-driven semantic conflict detection is a v2 candidate). **Versioning is git's job** — yaao does not touch the `version` field on refinement and keeps no parallel backup directory. `.yaao/skills/` is repo-tracked, so `git log -p` is the audit trail. A pre-refine `YAAO_SKILL_DIRTY` check surfaces uncommitted changes to the calling agent, which is expected to confirm with the user before re-calling with `force: true`.
- Recovery from a bad distillation: `rm -rf .yaao/skills/<name>` + `yaao skills install`. F12.6's watcher drops the stale `yaao_skill_<name>` tool in the same session. `yaao_prune` does not currently cover skills; a `target: skill` extension is a possible follow-up.

---

## Phase 18: Distribution

Publish yaao on npm and stand up a docs site. Sequenced last so the docs site can be built against a frozen v1 surface rather than chasing in-flight phases.

| Feature | Description | Doc |
| --- | --- | --- |
| **F18.1** | npm distribution | [F18.1-npm-publish.md](phase-18/F18.1-npm-publish.md) |
| **F18.2** | Docs site | [F18.2-docs-site.md](phase-18/F18.2-docs-site.md) |

**Key Deliverables:**

- Published as `yaao` on npm with `bin/yaao`, ESM-only, types included.
- Docs site (Astro or Docusaurus) with command reference, schema reference, walkthroughs.
- yaao does **not** collect telemetry. No event reporting, no installation IDs, no opt-in counter — by design.

---

## File Structure

```
yaao/
├── src/
│   ├── cli/                      # Command registry, top-level CLI (F1.2)
│   ├── config/                   # Config loader, schema, secrets (F1.3)
│   ├── init/                     # init command (F1.4)
│   ├── log/                      # Logger, error hierarchy (F1.5)
│   ├── plan/
│   │   ├── schema/               # Zod schema, JSON Schema export (F2.1)
│   │   ├── yaml/                 # YAML loader (F2.2)
│   │   └── validate/             # DAG validation (F2.3)
│   ├── git/
│   │   ├── worktree-manager.ts   # F3.1
│   │   ├── branch-graph.ts       # F3.2
│   │   ├── git.ts                # F3.3
│   │   └── journal.ts            # F3.4
│   ├── agents/
│   │   ├── backend.ts            # F4.1 interface
│   │   ├── claude-code.ts        # F4.2
│   │   ├── cursor.ts             # F4.3
│   │   ├── copilot.ts            # F4.4
│   │   ├── codex.ts              # F4.5
│   │   ├── api/                  # F4.6 (anthropic, openai, openrouter)
│   │   └── detect.ts             # F4.7
│   ├── exec/
│   │   ├── scheduler.ts          # F5.1
│   │   ├── lifecycle.ts          # F5.2
│   │   ├── context.ts            # F5.3
│   │   └── runner.ts             # F5.4 / F5.5
│   ├── merge/
│   │   ├── orchestrator.ts       # F6.1
│   │   ├── conflict.ts           # F6.2
│   │   ├── pr.ts                 # F6.3
│   │   └── commands.ts           # F6.4
│   ├── ctx-sys/
│   │   ├── detect.ts             # F7.1
│   │   ├── mcp-config.ts         # F7.2
│   │   ├── enforce.ts            # F7.3
│   │   └── hooks.ts              # F7.4
│   ├── skills/
│   │   ├── format.ts             # F8.1
│   │   ├── emitters/             # F8.2-F8.5
│   │   ├── install.ts            # F8.6
│   │   └── builtin/              # yaao-planner, yaao-converter
│   ├── planner/                  # F9
│   ├── converter/                # F10
│   ├── tui/
│   │   ├── primitives/           # F11.1
│   │   ├── view.tsx              # F11.2
│   │   ├── run.tsx               # F11.3
│   │   └── status.tsx            # F11.5
│   ├── mcp/                      # F12 — yaao-as-MCP server
│   ├── web/                      # F13 — HTTP+SSE server, plan/config editors
│   ├── doctor/                   # F15.1
│   └── distill/                  # F17 — session → skill distillation
├── tests/
│   ├── helpers/
│   ├── phase-1/ ... phase-18/
├── docs/
│   ├── IMPLEMENTATION.md
│   ├── phase-1/ ... phase-18/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (strict) |
| Runtime | Node ≥ 20, ES modules |
| CLI | `commander` |
| Schema | `zod` (+ `zod-to-json-schema`) |
| Config / plans | `yaml`, `gray-matter` |
| Markdown | `remark`, `remark-parse`, `remark-frontmatter` |
| Process | `execa`, `eventemitter3` |
| TUI | `ink`, `ink-spinner`, custom DAG renderer |
| MCP | `@modelcontextprotocol/sdk` (client + server) |
| Anthropic SDK | `@anthropic-ai/sdk` (with prompt caching) |
| OpenAI SDK | `openai` |
| Web (Phase 13) | `hono` + React + a graph layout lib |
| Tests | `vitest` |
| Bundler | `tsup` |

---

## Testing Strategy

- **Unit tests** — every module with mocked git, MCP, agents.
- **Integration tests** — real `git` against ephemeral repos for worktree/merge flows.
- **Agent fakes** — a `fake-agent` backend that scripts predetermined edits/diffs/timing for deterministic execution-engine tests.
- **DAG fuzz tests** — generated DAGs (cycles, diamonds, fans) feed the validator and scheduler.
- **End-to-end** — `init` → `plan` → `convert` → `run` → `merge` against a fixture repo, with the API backend pinned to a recorded transcript.

---

## Implementation Priority

1. Phases 1-3 are the critical path — without config, schema, and worktrees, nothing else works.
2. Phase 4 + 5 + 6 unlock the first end-to-end demo: a hand-written YAML plan that runs across worktrees and merges back.
3. **Phase 12 (yaao-as-MCP) is built alongside Phase 8**, not after it. The skills emitters in Phase 8 emit MCP bootstraps that point at the Phase 12 server, so the two are co-dependent. Build the MCP server scaffold (F12.1) first, then F8.1 (skill format), then F12.5 (skill-as-tool exposure), then the per-agent emitters (F8.2-F8.5).
4. Phase 7 (ctx-sys) is fully optional and independent; can land any time after Phase 5. Default-off in shipped config.
5. Phases 9-10 (planner/converter skills) build on the MCP-tool path established in 8 + 12.
6. Phase 11 (TUI) can be developed alongside 5/6 since it just consumes the event bus.
7. Phase 13 (web viewer) ships independently of the engine. Phase 14 (integration correctness) lands first among the remaining phases — it fixes the enable/disable contract and the per-spawn MCP overlays that everything downstream depends on. Phase 15 (release polish) is the gating step before tagging v1. Phase 16 (concurrent runs + context handoff) unlocks the two-feature-branches-side-by-side workflow the worktree model was shaped for. Phase 17 (distillation) and Phase 18 (npm + docs site) follow.

---

## Getting Started

1. Build Phase 1 first; it gates everything.
2. Each feature doc contains data models, public API, acceptance criteria, and tests.
3. Run `vitest run` after each feature; do not move on until tests pass.
4. The first runnable end-to-end demo lands at the end of Phase 6 with a hand-written YAML plan.
5. The first "plan from prompt" demo lands at the end of Phase 10.
