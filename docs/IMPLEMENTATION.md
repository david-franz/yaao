# Implementation Plan

This document is the working spec for `yaao`, organized by phase. Each feature has a detailed specification in its own file under `phase-N/`.

## Overview

yaao is implemented in 14 phases, progressing from foundational CLI infrastructure through the execution engine, agent integrations, the planner/converter skills, the TUI, and finally distribution and the web viewer.

| Phase | Focus | Features | Status |
|-------|-------|----------|--------|
| 1  | Foundation                  | Project setup, CLI, config, init command, logging               | Planned |
| 2  | Plan schema & validation    | Zod schema, YAML parser, DAG validation, `validate`             | Planned |
| 3  | Worktree & git engine       | Worktree manager, branch graph, git wrapper, run journal        | Planned |
| 4  | Agent backends              | Backend interface + Claude Code, Cursor, Copilot, Codex, API    | Planned |
| 5  | Execution engine            | Scheduler, lifecycle, event bus, `run`, resume, dry-run         | Planned |
| 6  | Merge engine                | Topological merge, manual/auto/agent conflict modes, PR mode    | Planned |
| 7  | ctx-sys integration         | Detection, auto-spawn, MCP injection, query enforcement         | Planned |
| 8  | Skills system               | Source-of-truth format, per-agent emitters, `skills install`    | Planned |
| 9  | yaao-planner skill          | Plan generation (markdown + Spec Kit), `plan` command           | Planned |
| 10 | yaao-converter skill        | Plan → execution-plan compiler, `convert` command               | Planned |
| 11 | TUI                         | Ink primitives, DAG renderer, `view`, live monitor, streaming   | Planned |
| 12 | yaao-as-MCP                 | MCP server exposing `generate_plan`, `convert_plan`, `run_plan` | Planned |
| 13 | Distribution & polish       | npm publish, `doctor`, telemetry (opt-in), docs                 | Planned |
| 14 | Web viewer                  | HTTP server, browser-based DAG/run viewer                       | Planned |

---

## Phase 1: Foundation

Sets up the TypeScript project, CLI skeleton, configuration system, and the `init` command. Everything else builds on this.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F1.1** | Project setup & build pipeline                | [F1.1-project-setup.md](phase-1/F1.1-project-setup.md) |
| **F1.2** | CLI skeleton & command registry               | [F1.2-cli-skeleton.md](phase-1/F1.2-cli-skeleton.md) |
| **F1.3** | Configuration system (`yaao.config.json`)     | [F1.3-config-system.md](phase-1/F1.3-config-system.md) |
| **F1.4** | `yaao init` command                           | [F1.4-init-command.md](phase-1/F1.4-init-command.md) |
| **F1.5** | Logging & error handling                      | [F1.5-logging-errors.md](phase-1/F1.5-logging-errors.md) |

**Key Deliverables:**
- TypeScript + Node ≥ 20 + ESM project, bundled with `tsup`, tested with `vitest`.
- `commander`-based CLI with stub commands for the full surface area.
- Layered config: defaults → global (`~/.yaao/config.json`) → project (`.yaao/yaao.config.json`) → secrets (`.yaao/secrets.local.json`) → env-var expansion.
- `yaao init` scaffolds `.yaao/`, writes `yaao.config.json`, `.yaaoignore`, updates `.gitignore`.
- Structured logger with levels, JSON-or-text output, and a typed error hierarchy.

---

## Phase 2: Plan Schema & Validation

The execution-plan schema is the lingua franca that connects the planner, converter, scheduler, and viewer. This phase pins it down.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F2.1** | Execution-plan schema (Zod + JSON Schema)     | [F2.1-execution-plan-schema.md](phase-2/F2.1-execution-plan-schema.md) |
| **F2.2** | YAML parser & loader                          | [F2.2-yaml-parser.md](phase-2/F2.2-yaml-parser.md) |
| **F2.3** | DAG validation (cycles, missing refs, fan-out)| [F2.3-dag-validation.md](phase-2/F2.3-dag-validation.md) |
| **F2.4** | `yaao validate` command                       | [F2.4-validate-command.md](phase-2/F2.4-validate-command.md) |

**Key Deliverables:**
- Single canonical Zod schema for execution plans; `.json-schema` artifact emitted for editor IntelliSense.
- YAML loader supporting `include` for sub-plans, with cycle detection across files.
- DAG validator: cycles, missing dependency IDs, duplicate task IDs, fan-out limits, agent/model availability.
- `yaao validate` returns non-zero on invalid plans with precise error locations (file/line/column).

---

## Phase 3: Worktree & Git Engine

The mechanical layer that lets multiple agents work on the same repo at once without colliding.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F3.1** | Worktree manager                            | [F3.1-worktree-manager.md](phase-3/F3.1-worktree-manager.md) |
| **F3.2** | Dependency-aware branch graph               | [F3.2-branch-graph.md](phase-3/F3.2-branch-graph.md) |
| **F3.3** | Git operations wrapper                      | [F3.3-git-wrapper.md](phase-3/F3.3-git-wrapper.md) |
| **F3.4** | Run state journal                           | [F3.4-run-journal.md](phase-3/F3.4-run-journal.md) |

**Key Deliverables:**
- Per-task worktree creation/teardown under `.yaao/worktrees/<run-id>/<task-id>/`.
- Dependent tasks branch off the parent's branch (not `main`); diamond DAGs merge multiple parents into the worktree before launch.
- Thin, typed wrapper around `git` (via `execa`) covering worktree, branch, merge, status, push, fetch.
- Append-only run journal at `.yaao/runs/<run-id>.json` enabling crash-resume.

---

## Phase 4: Agent Backends

A uniform `AgentBackend` interface plus an implementation for every supported agent in the v1 release.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F4.1** | `AgentBackend` interface                    | [F4.1-agent-backend-interface.md](phase-4/F4.1-agent-backend-interface.md) |
| **F4.2** | Claude Code backend                         | [F4.2-claude-code-backend.md](phase-4/F4.2-claude-code-backend.md) |
| **F4.3** | Cursor backend                              | [F4.3-cursor-backend.md](phase-4/F4.3-cursor-backend.md) |
| **F4.4** | GitHub Copilot backend                      | [F4.4-copilot-backend.md](phase-4/F4.4-copilot-backend.md) |
| **F4.5** | Codex backend                               | [F4.5-codex-backend.md](phase-4/F4.5-codex-backend.md) |
| **F4.6** | API backend (Anthropic / OpenAI / OpenRouter)| [F4.6-api-backend.md](phase-4/F4.6-api-backend.md) |
| **F4.7** | Backend detection & `yaao agents`           | [F4.7-backend-detection.md](phase-4/F4.7-backend-detection.md) |

**Key Deliverables:**
- One interface: `name`, `isAvailable()`, `spawn(options) → AgentProcess { pid, completed, cancel, output$ }`.
- Each CLI-based backend invokes the agent in non-interactive print mode, captures stdout/stderr, surfaces them as a streaming output observable.
- API backend uses provider SDKs with tool-use loop; supports prompt caching where available.
- `yaao agents` lists all backends with availability and version detection, via the `doctor`-shared probe layer.

---

## Phase 5: Execution Engine

The brain. Walks the DAG, runs ready tasks within a parallelism budget, passes context between dependent tasks, persists state.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F5.1** | DAG scheduler                               | [F5.1-dag-scheduler.md](phase-5/F5.1-dag-scheduler.md) |
| **F5.2** | Task lifecycle & event bus                  | [F5.2-task-lifecycle.md](phase-5/F5.2-task-lifecycle.md) |
| **F5.3** | Context passing between tasks               | [F5.3-context-passing.md](phase-5/F5.3-context-passing.md) |
| **F5.4** | `yaao run` command                          | [F5.4-run-command.md](phase-5/F5.4-run-command.md) |
| **F5.5** | Resume, `--only`, `--skip`, `--dry-run`     | [F5.5-run-modes.md](phase-5/F5.5-run-modes.md) |

**Key Deliverables:**
- Topological scheduler: tracks pending → ready → active → completed/failed/skipped, respects `max-parallel`.
- `eventemitter3` event bus emitting `task:queued`, `task:running`, `task:output`, `task:completed`, `task:failed`, `run:complete`, `run:failed`.
- Completed tasks surface a `context.md` artifact (last N lines of agent output + diff summary) that's auto-appended to dependents' prompts.
- `yaao run` orchestrates everything, including ctx-sys spawn, TUI launch, and signal handling for graceful shutdown.
- `--resume` replays the run journal; `--only` / `--skip` filter the DAG; `--dry-run` walks the DAG without spawning agents.

---

## Phase 6: Merge Engine

How completed worktrees come back together — and what happens when they collide.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F6.1** | Topological merge orchestration             | [F6.1-merge-orchestration.md](phase-6/F6.1-merge-orchestration.md) |
| **F6.2** | Auto / manual / agent conflict modes        | [F6.2-conflict-modes.md](phase-6/F6.2-conflict-modes.md) |
| **F6.3** | PR merge mode (`gh pr create`)              | [F6.3-pr-mode.md](phase-6/F6.3-pr-mode.md) |
| **F6.4** | `yaao merge` & `yaao clean`                 | [F6.4-merge-clean-commands.md](phase-6/F6.4-merge-clean-commands.md) |

**Key Deliverables:**
- Merge happens in topological order to minimize conflicts; a trial-merge probe detects conflicts before committing.
- Default conflict mode is `manual`: yaao halts, points at the conflict markers, and waits for the human.
- `agent` mode (opt-in) spawns a configured resolver agent against the conflicted files; output is verified with `git diff --check` before committing.
- `auto` only ever commits a clean merge; refuses to silently resolve markers.
- Per-task `merge: pr` pushes the branch and creates a PR via `gh pr create`, with auto-generated title/body and idempotency.
- `yaao clean` tears down worktrees and (optionally) branches; refuses to clean unmerged work without `--force`.

---

## Phase 7: ctx-sys Integration

Make ctx-sys a first-class context provider for every agent yaao spawns, without making it mandatory.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F7.1** | Detection & auto-spawn                      | [F7.1-detect-and-spawn.md](phase-7/F7.1-detect-and-spawn.md) |
| **F7.2** | Per-agent MCP config injection              | [F7.2-mcp-injection.md](phase-7/F7.2-mcp-injection.md) |
| **F7.3** | Query enforcement (`require-query`)         | [F7.3-query-enforcement.md](phase-7/F7.3-query-enforcement.md) |
| **F7.4** | Optional git-hook impact reports            | [F7.4-impact-hook.md](phase-7/F7.4-impact-hook.md) |

**Key Deliverables:**
- yaao detects `.ctx-sys/` and probes whether `ctx-sys serve` is running on the project socket; if not and `auto-spawn: true`, spawns one.
- Generates ephemeral MCP config files per agent: Claude Code via `--mcp-config`, Cursor by writing `.cursor/mcp.json`, Codex via `~/.codex/config.toml` overlay, API backend by registering tools.
- Every step gets a system-prompt directive: "Before writing or modifying code, call the `context_query` MCP tool with a query relevant to your task."
- When `require-query: true`, yaao tails the MCP server log; if a step produces a non-empty diff without any `context_query` calls, the step fails with a clear error.
- Optional: install a git pre-commit hook that calls `ctx-sys hooks.impact_report` and feeds the result to merge-time conflict-resolution agents.

---

## Phase 8: Skills System

One source-of-truth skill, four agent formats. Plus the two built-in skills (`yaao-planner`, `yaao-converter`) that the next two phases depend on.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F8.1** | Skill source-of-truth format                | [F8.1-skill-format.md](phase-8/F8.1-skill-format.md) |
| **F8.2** | Claude Code emitter                         | [F8.2-claude-code-emitter.md](phase-8/F8.2-claude-code-emitter.md) |
| **F8.3** | Cursor emitter                              | [F8.3-cursor-emitter.md](phase-8/F8.3-cursor-emitter.md) |
| **F8.4** | Copilot emitter                             | [F8.4-copilot-emitter.md](phase-8/F8.4-copilot-emitter.md) |
| **F8.5** | Codex emitter                               | [F8.5-codex-emitter.md](phase-8/F8.5-codex-emitter.md) |
| **F8.6** | `yaao skills install` / sync                | [F8.6-skills-install.md](phase-8/F8.6-skills-install.md) |

**Key Deliverables:**
- `.yaao/skills/<name>/skill.yaml` (metadata + applies-to + tools) + `prompt.md` (body) as the source of truth.
- Emitters generate the right artifact in the right place for each agent, idempotently, with a fingerprint so re-installs are detectable.
- `yaao skills install` writes for all enabled agents; `yaao skills install --agent <name>` for one; `yaao skills sync` updates if source-of-truth changed.
- Generated files include a `# Managed by yaao — do not edit` header and a hash; manual edits are detected and surfaced.

---

## Phase 9: yaao-planner Skill

The skill that authors implementation plans, plus the CLI driver that invokes it.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F9.1** | Skill design (system prompt, tools, guard-rails) | [F9.1-planner-skill.md](phase-9/F9.1-planner-skill.md) |
| **F9.2** | Markdown plan format & template             | [F9.2-markdown-format.md](phase-9/F9.2-markdown-format.md) |
| **F9.3** | Spec Kit format support                     | [F9.3-speckit-format.md](phase-9/F9.3-speckit-format.md) |
| **F9.4** | Feature vs project scope                    | [F9.4-scope-modes.md](phase-9/F9.4-scope-modes.md) |
| **F9.5** | `yaao plan` command                         | [F9.5-plan-command.md](phase-9/F9.5-plan-command.md) |

**Key Deliverables:**
- `yaao-planner` skill: knows the markdown convention, the Spec Kit triplet, when to break a plan into multiple files, and is required to call `context_query` first if ctx-sys is enabled.
- Markdown convention: numbered phase headings, task tables with `id`/`depends`/`agent` hints, fenced YAML for explicit step config.
- Spec Kit format: emits compatible `spec.md` + `plan.md` + `tasks.md`.
- `--scope feature` produces a single plan file; `--scope project` produces a multi-phase, multi-directory plan.
- `yaao plan` drives the user's default agent (or `--agent`) to run the skill; output is written to `.yaao/plans/`.

---

## Phase 10: yaao-converter Skill

Turns any implementation plan (yaao-authored or not) into a deterministic execution plan.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F10.1** | Skill design                               | [F10.1-converter-skill.md](phase-10/F10.1-converter-skill.md) |
| **F10.2** | Markdown plan parser                       | [F10.2-markdown-parser.md](phase-10/F10.2-markdown-parser.md) |
| **F10.3** | Spec Kit plan parser                       | [F10.3-speckit-parser.md](phase-10/F10.3-speckit-parser.md) |
| **F10.4** | Dependency inference                       | [F10.4-dependency-inference.md](phase-10/F10.4-dependency-inference.md) |
| **F10.5** | Default agent assignment                   | [F10.5-agent-assignment.md](phase-10/F10.5-agent-assignment.md) |
| **F10.6** | `yaao convert` command                     | [F10.6-convert-command.md](phase-10/F10.6-convert-command.md) |

**Key Deliverables:**
- `yaao-converter` skill: deterministic schema-validated YAML output, infers missing fields, asks for clarification when ambiguous.
- Markdown parser using `remark` extracts tasks, prose, and embedded fenced YAML.
- Spec Kit parser maps `tasks.md` items to execution-plan tasks 1:1.
- Dependency inference: phase ordering + textual cues ("after X exists", "depends on Y") → explicit `depends:` arrays. User can review/override before running.
- Default agent assignment heuristic based on task tags: tests → opinionated agent, UI → opinionated agent, infra → opinionated agent (configurable in `yaao.config.json`).
- `--split` emits one execution-plan file per phase plus a top-level plan with `include:` references.

---

## Phase 11: TUI

Static plan viewer, live execution monitor, and the rendering primitives behind both.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F11.1** | Ink rendering primitives & DAG renderer    | [F11.1-ink-primitives.md](phase-11/F11.1-ink-primitives.md) |
| **F11.2** | `yaao view` (static)                       | [F11.2-view-command.md](phase-11/F11.2-view-command.md) |
| **F11.3** | `yaao run` live monitor                    | [F11.3-run-monitor.md](phase-11/F11.3-run-monitor.md) |
| **F11.4** | Agent output streaming                     | [F11.4-output-streaming.md](phase-11/F11.4-output-streaming.md) |
| **F11.5** | `yaao status` command                      | [F11.5-status-command.md](phase-11/F11.5-status-command.md) |

**Key Deliverables:**
- Shared rendering primitives: status table, DAG layout (Sugiyama-style with width caps), log pane, key-help footer.
- `yaao view` opens the plan in static mode: DAG, per-task panel, parallelism width.
- `yaao run` opens the live monitor: task table + log pane, keybindings (`↑↓ enter q r`), cancellable in-flight tasks.
- Real-time agent output streamed via the backend's `output$` observable, not buffered until the task ends.
- `yaao status [run-id]` prints the run's task table for a finished run; with `--watch` it tails an in-flight run.

---

## Phase 12: yaao-as-MCP

Expose yaao itself as an MCP server so any MCP-capable agent can drive it.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F12.1** | MCP server scaffold                        | [F12.1-mcp-server.md](phase-12/F12.1-mcp-server.md) |
| **F12.2** | `generate_plan` tool                       | [F12.2-generate-plan-tool.md](phase-12/F12.2-generate-plan-tool.md) |
| **F12.3** | `convert_plan` tool                        | [F12.3-convert-plan-tool.md](phase-12/F12.3-convert-plan-tool.md) |
| **F12.4** | `run_plan` & `status` tools                | [F12.4-run-plan-tool.md](phase-12/F12.4-run-plan-tool.md) |

**Key Deliverables:**
- `yaao serve` exposes an MCP server over stdio (default) or socket.
- `generate_plan` mirrors `yaao plan` programmatically; returns the plan as text plus the path it was written to.
- `convert_plan` mirrors `yaao convert`; returns the resulting YAML and validates it.
- `run_plan` starts a run asynchronously and returns a run ID; `status` returns live state. Long-running progress is delivered via MCP progress notifications.

---

## Phase 13: Distribution & Polish

Make yaao installable, diagnosable, and documented.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F13.1** | `yaao doctor`                              | [F13.1-doctor.md](phase-13/F13.1-doctor.md) |
| **F13.2** | npm distribution                           | [F13.2-npm-publish.md](phase-13/F13.2-npm-publish.md) |
| **F13.3** | Docs site                                  | [F13.3-docs-site.md](phase-13/F13.3-docs-site.md) |
| **F13.4** | Telemetry (opt-in)                         | [F13.4-telemetry.md](phase-13/F13.4-telemetry.md) |

**Key Deliverables:**
- `yaao doctor` checks: Node version, git version, agent CLI presence + versions, ctx-sys presence + version, config sanity, write permissions, secrets-not-in-config rule.
- Published as `yaao` on npm with `bin/yaao`, ESM-only, types included.
- Docs site (Astro or Docusaurus) with command reference, schema reference, walkthroughs.
- Opt-in anonymous telemetry: command name, exit code, duration, OS — strictly no plan content, no diffs, no prompts.

---

## Phase 14: Web Viewer

Browser-based DAG and run viewer; an alternative to the TUI for users who prefer it.

| Feature | Description | Doc |
|---------|-------------|-----|
| **F14.1** | `yaao serve --web` HTTP server             | [F14.1-web-server.md](phase-14/F14.1-web-server.md) |
| **F14.2** | DAG view (static)                          | [F14.2-web-dag-view.md](phase-14/F14.2-web-dag-view.md) |
| **F14.3** | Live run view                              | [F14.3-web-run-view.md](phase-14/F14.3-web-run-view.md) |

**Key Deliverables:**
- Local HTTP server (Hono or Fastify) bound to `127.0.0.1` with a randomly-bound port; opens a browser via `open`.
- Static DAG view rendered with React + a graph layout library; same data the TUI uses.
- Live view subscribes to the run's event stream over Server-Sent Events; mirrors the TUI's task table and log pane.

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
│   ├── doctor/                   # F13.1
│   ├── telemetry/                # F13.4
│   └── web/                      # F14
├── tests/
│   ├── helpers/
│   ├── phase-1/ ... phase-14/
├── docs/
│   ├── IMPLEMENTATION.md
│   ├── phase-1/ ... phase-14/
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
| Web (Phase 14) | `hono` + React + a graph layout lib |
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
3. Phase 7 (ctx-sys) is independent of 8-10; can be developed in parallel once 5 lands.
4. Phases 8-10 enable the "plan from a description" workflow that is yaao's headline feature.
5. Phase 11 (TUI) can be developed alongside 5/6 since it just consumes the event bus.
6. Phases 12-14 are polish/distribution and can ship independently.

---

## Getting Started

1. Build Phase 1 first; it gates everything.
2. Each feature doc contains data models, public API, acceptance criteria, and tests.
3. Run `vitest run` after each feature; do not move on until tests pass.
4. The first runnable end-to-end demo lands at the end of Phase 6 with a hand-written YAML plan.
5. The first "plan from prompt" demo lands at the end of Phase 10.
