# Implementation Plan

This document is the working spec for `yaao`, organized by phase. Each feature has a detailed specification in its own file under `phase-N/`.

## Overview

yaao is implemented in 16 phases, progressing from foundational CLI infrastructure through the execution engine, agent integrations, the planner/converter skills, the TUI, the MCP server, the web viewer, release polish, session-to-skill distillation, and finally npm distribution + the docs site.

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
| 14 | Release polish              | `yaao doctor` (incl. orphan-run detection), `yaao init --mcp`, quickstart + examples, error-hint audit, README truth-up | Planned |
| 15 | Session → Skill distillation | `yaao-distiller` skill, session readers, `yaao_distill` MCP tool, refinement | Planned |
| 16 | Distribution                | npm publish, docs site | Planned |

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
| **F7.4** | Optional git-hook impact reports            | shipped | [F7.4-impact-hook.md](phase-7/F7.4-impact-hook.md) |

**Key Deliverables:**
- Default-off in `yaao.config.json`. When `ctx-sys.enabled: true`, yaao detects whether `ctx-sys serve` is running and (if `auto-spawn: true`) spawns it for the run.
- Generic MCP-server registration: ctx-sys is one entry; users can add other MCP servers via `mcp-servers:` and they flow through the same injection path.
- Every step gets an advisory system-prompt directive recommending `context_query` before writing code. **No hard enforcement** — agents decide whether to query.
- Optional: install a git pre-commit hook that calls `ctx-sys hooks.impact_report` and feeds the result to merge-time conflict-resolution agents.

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
- Every user-defined skill in `.yaao/skills/` is auto-registered as `yaao_skill_<name>` with input schema derived from `skill.yaml` (F12.5). A debounced FS watcher keeps the catalog in sync mid-session: adding or removing a skill directory triggers register/remove + `tools/list_changed` within ~250 ms, no reconnect needed (F12.6). This is what makes the Phase 15 distiller's "callable in the next turn" UX work.

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

## Phase 14: Release Polish

The work that turns yaao from feature-complete into v1-shippable. Closes the first-use gaps (auto-MCP registration on `yaao init`, an environment-audit `yaao doctor`, a 60-second quickstart), audits error messages + their hints, and trues up the README to what the engine actually does. Sequenced ahead of distillation (Phase 15) and distribution (Phase 16) so polish lands before either of those branches off. See [phase-14/PHASE-14.md](phase-14/PHASE-14.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F14.1** | `yaao doctor` (subsumes `yaao agents`; orphan-run detection) | [F14.1-doctor.md](phase-14/F14.1-doctor.md) |
| **F14.2** | `yaao init --mcp` — auto-register yaao's MCP server in `.mcp.json` | [F14.2-init-mcp.md](phase-14/F14.2-init-mcp.md) |
| **F14.3** | First-use experience — 60-second quickstart + `examples/` directory | [F14.3-first-use.md](phase-14/F14.3-first-use.md) |
| **F14.4** | Error message + hint audit | [F14.4-error-hints.md](phase-14/F14.4-error-hints.md) |
| **F14.5** | README + IMPLEMENTATION.md accuracy pass | [F14.5-docs-truthup.md](phase-14/F14.5-docs-truthup.md) |

**Key Deliverables:**

- `yaao doctor` is the single command a confused user can run: Node version, git version, agent CLI presence + versions, ctx-sys presence + version, config sanity, write permissions, secrets-not-in-config rule, every enabled provider's API key resolves. Subsumes the per-agent availability check previously surfaced as `yaao agents`. **Also detects orphaned runs** — runs whose journal still says `running` but whose `runner.pid` is dead or whose journal mtime is stale — closing the "kill -9 left it stuck on running" gap that the CLI's SIGINT/SIGTERM handler (5a05f8c) doesn't cover. The same helper feeds `yaao_inspect`'s workspace listing so the web viewer's status pill stops lying.
- `yaao init` default-on writes a `yaao` entry to the project's `.mcp.json` (and the per-agent equivalents: `.cursor/mcp.json`, `~/.codex/config.toml`, an inline reference in `.github/copilot-instructions.md`). Preserves siblings, never silently overwrites an existing `yaao` entry that differs from what we'd write. `--no-mcp` opts out.
- A copy-pasteable five-line quickstart in the README — `npm i -g yaao && yaao init && yaao plan ... && yaao convert ... && yaao run ...` — works on a fresh machine because F14.1 + F14.2 close the previously-manual setup gap. Three real, runnable plans under `examples/` (TypeScript monorepo, Python service, C kernel) double as live tests of the convention.
- Every user-facing `YaaoError` carries a `hint:` that points at the fix; stale hints (referencing renamed commands) are caught.
- The README + IMPLEMENTATION.md sweep closes accumulated drifts: API backend status (no longer stubs for Anthropic), `yaao agents` retired into `yaao doctor`, `format: both` and `--scope project` either dropped or marked experimental, all phase-N references retargeted after this renumbering. Runs *last* in the phase so drift introduced by F14.1–F14.4 is caught in the same pass.
- End-to-end validation on real projects is deliberately **not** a Phase 14 feature — it's done out-of-band as part of v1 sign-off so the phase has a deterministic completion bar (every feature shipped + tested) rather than a human-time-dependent one.

---

## Phase 15: Session → Skill Distillation

Close the missing half of the skill lifecycle: capture the patterns from a finished chat session — conventions, focus files, user corrections, the approach that actually worked — and crystallize them into a reusable yaao skill that immediately becomes available across every connected agent via the existing F8.1 format, F12.5 auto-MCP-registration, and F12.6 hot reload. See [phase-15/PHASE-15.md](phase-15/PHASE-15.md) for the phase overview.

| Feature | Description | Doc |
| --- | --- | --- |
| **F15.1** | `yaao-distiller` built-in skill | [F15.1-distiller-skill.md](phase-15/F15.1-distiller-skill.md) |
| **F15.2** | In-session capture (`SessionRecord` contract, redaction) | [F15.2-session-readers.md](phase-15/F15.2-session-readers.md) |
| **F15.3** | Skill emission, validation, post-emit install | [F15.3-skill-emission.md](phase-15/F15.3-skill-emission.md) |
| **F15.4** | `yaao_distill` MCP tool (sole entry point) | [F15.4-distill-mcp-tool.md](phase-15/F15.4-distill-mcp-tool.md) |
| **F15.5** | Skill refinement (re-distill, diff review) | [F15.5-skill-refinement.md](phase-15/F15.5-skill-refinement.md) |

**Key Deliverables:**

- `yaao-distiller` joins `yaao-planner` and `yaao-converter` as a third built-in skill under `src/skills/builtin/`. Its prompt is the whole product: a three-stage pipeline (identify the generalizable task → split signal from instance → emit a draft `skill.yaml` + `prompt.md`) with explicit anti-leakage rules.
- **MCP is the only entry point.** Unlike every other yaao command, Phase 15 has no shell-CLI surface — distillation is inherently in-context, and the agent producing the `SessionRecord` is by definition the agent calling the tool. The calling agent supplies its own structured self-summary as the `session` argument; yaao never reads IDE-internal transcript stores. Works across every supported agent (Claude Code, Cursor, Copilot, Codex, raw API).
- `yaao_distill` writes to `.yaao/skills/<name>/` (project) or `~/.yaao/skills/<name>/` (user) and reuses `validateSkill` from F8.1. After write, `yaao skills install` re-emits per-agent stubs automatically. F12.6's hot reload picks up the new directory and the SDK fires `tools/list_changed` — so a skill distilled from a Claude Code session is callable from Cursor, Copilot, Codex, and the raw API in the next turn, with no reconnect.
- **F15.1, F15.2, and F15.3 land together** as one PR — the distiller prompt, the `SessionRecord` contract it consumes, and the emission pipeline it produces output for are deeply coupled and can't be sensibly built in isolation. F15.4 (MCP driver) and F15.5 (refinement) layer on top once those three are working end-to-end.
- Refinement (F15.5): re-run the distiller against an existing skill with a fresh session. The distiller merges (preserving anti-patterns and distillation notes); yaao returns a diff + changelog in the MCP response so the calling agent can show the user before committing (or call with `apply: false` for explicit preview). Contradictions between old and new conventions block auto-apply, detected via a **structural rule** over backtick-quoted identifiers shared between bullets (LLM-driven semantic conflict detection is a v2 candidate). **Versioning is git's job** — yaao does not touch the `version` field on refinement and keeps no parallel backup directory. `.yaao/skills/` is repo-tracked, so `git log -p` is the audit trail. A pre-refine `YAAO_SKILL_DIRTY` check surfaces uncommitted changes to the calling agent, which is expected to confirm with the user before re-calling with `force: true`.
- Recovery from a bad distillation: `rm -rf .yaao/skills/<name>` + `yaao skills install`. F12.6's watcher drops the stale `yaao_skill_<name>` tool in the same session. `yaao_prune` does not currently cover skills; a `target: skill` extension is a possible follow-up.

---

## Phase 16: Distribution

Publish yaao on npm and stand up a docs site. Sequenced last so the docs site can be built against a frozen v1 surface rather than chasing in-flight phases.

| Feature | Description | Doc |
| --- | --- | --- |
| **F16.1** | npm distribution | [F16.1-npm-publish.md](phase-16/F16.1-npm-publish.md) |
| **F16.2** | Docs site | [F16.2-docs-site.md](phase-16/F16.2-docs-site.md) |

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
│   ├── doctor/                   # F14.1
│   └── distill/                  # F15 — session → skill distillation
├── tests/
│   ├── helpers/
│   ├── phase-1/ ... phase-16/
├── docs/
│   ├── IMPLEMENTATION.md
│   ├── phase-1/ ... phase-16/
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
7. Phase 13 (web viewer) ships independently of the engine. Phase 14 (release polish) is the gating step before tagging v1; Phase 15 (distillation) and Phase 16 (npm + docs site) follow.

---

## Getting Started

1. Build Phase 1 first; it gates everything.
2. Each feature doc contains data models, public API, acceptance criteria, and tests.
3. Run `vitest run` after each feature; do not move on until tests pass.
4. The first runnable end-to-end demo lands at the end of Phase 6 with a hand-written YAML plan.
5. The first "plan from prompt" demo lands at the end of Phase 10.
