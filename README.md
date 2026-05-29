# yaao — yet another agent orchestrator

`yaao` is a CLI for the full lifecycle of multi-agent software work:

1. **Plan** — generate implementation plans (plain markdown, [Spec Kit](https://github.com/github/spec-kit) format, or both) for either a single feature in an existing codebase or a green-field project across many subdirectories and phases.
2. **Convert** — turn any implementation plan (one yaao made or one you wrote yourself) into a deterministic, machine-runnable **execution plan** in YAML, with explicit step dependencies.
3. **Run** — execute the plan across multiple agents in parallel using **git worktrees** (one worktree per task), with merging back to a base branch.
4. **Inspect & resume** — watch a running plan, browse history, recover from partial failures, all via the same CLI you started from or the MCP tools.

It is editor- and agent-agnostic: every step in an execution plan can be assigned to **Claude Code**, **Cursor**, **GitHub Copilot**, **Codex**, or a raw **Anthropic API** model. The integration story across these is **MCP-first** — yaao itself is an MCP server, every agent registers it the same way, and skills live behind the MCP boundary instead of being duplicated per-agent. It integrates natively with [`ctx-sys`](../ctx-sys) for context retrieval when configured — agents are explicitly directed to query ctx-sys before writing code.

---

## Status

**MVP + MCP + Web Viewer + Integration Correctness + Release Polish shipped.** Phases 1-15 are complete: foundation, plan schema & validation, the worktree & git engine, agent backends, the execution engine, the merge engine, optional ctx-sys integration, the skills system, the yaao-planner skill, the yaao-converter skill, the text-mode TUI, **yaao-as-MCP** — `yaao serve` exposes `yaao_plan` / `yaao_convert` / `yaao_validate` / `yaao_run` / `yaao_resume` / `yaao_stop` / `yaao_status` / `yaao_agents` / `yaao_plans` / `yaao_inspect` / `yaao_prune` as MCP tools, plus auto-registers every discoverable skill as `yaao_skill_<name>` with hot reload — and **`yaao web`**, the browser viewer for DAGs, live runs (with full agent-activity stream), workspace cleanup, plan editing with YAML syntax highlighting + dependency-layer navigation, rendered implementation-plan source viewer, secrets-aware config editor, and light/dark theming. This is the integration story that lets Claude Code, Cursor, Copilot, Codex, and other MCP clients drive yaao end-to-end without duplicating prompts across four agent formats.

Recent additions worth knowing about even mid-MVP: a per-plan `plan.featureBranch` so feature-branch routing lives in the plan YAML instead of mutating workspace config per feature; a `yaao stop` CLI + `yaao_stop` MCP tool that cross-process cancels a run via SIGTERM (the runner stamps `cancelled` in the journal before exit); a converter `YAAO_PLAN_NARROW_DAG` warning that nudges away from strict-chain plans; and planner-skill prompt updates that prefer parallel siblings over a serial spine.

> **ctx-sys runtime caveat.** Phase 7's yaao-side code (detect, auto-spawn, MCP injection, directive, optional pre-commit hook) is shipped, but live auto-spawn depends on the `ctx-sys serve --socket <path>` + ready-signal contract being formalized in ctx-sys 2.0 ([F1.3](../ctx-sys/docs/v2/phase-1/F1.3-yaao-native-integration.md)). Until ctx-sys 2.0 lands, setting `ctx-sys.enabled: true` errors at first task spawn. The default config (`ctx-sys.enabled: false`) is unaffected.

Planned phases (in this order):

- **Phase 14 — Integration Correctness** *(shipped)*: enable/disable enforcement end-to-end (disabling `claude-code` in config now actually prevents claude-code agents from spawning), per-spawn MCP overlays for Cursor/Codex/Copilot (all four CLI agents receive ctx-sys + per-plan MCP servers at run time), Anthropic prompt caching with cache-token telemetry, working OpenAI and OpenRouter provider implementations (the v0.0.1 stubs that threw at spawn time are gone), a Copilot four-phase isAvailable probe with accurate gh-copilot extension version reporting, skip-if-missing live backend smoke tests under `tests/phase-14/live/` with a nightly CI job, Spec Kit parser relaxed for common authoring variants + `YAAO_SPECKIT_PARSE_EMPTY` warning + `spec.md`/`plan.md` content propagation through `plan.context`, a config UX & model-discovery sweep (`plan.agent`/`plan.model` block, dead `plan.speckit` cleanup, `merge.history: rebase` default, `yaao agents --models` with per-backend KNOWN_MODELS catalog, working `$schema` URL, "binary not found on PATH" rendering replacing "exited -1"), `git.detectDefaultBranch` so `yaao init` writes the repo's actual default branch + runtime `YAAO_BASE_BRANCH_MISSING` validation + `--feature-branch` CLI flag plumbed across plan/convert/run, and `yaao skills import` from claude/cursor/copilot/codex/generic formats so any single-provider library becomes cross-provider via MCP. **End-of-phase guarantee**: any plan step can confidently be assigned to `claude-code`, `cursor`, `codex`, `copilot`, or `api` (with `anthropic` / `openai` / `openrouter`); the config block tells the user honestly what's wired up, what models each backend accepts, what branch the work lands on, and where to look when something breaks; and the user's existing single-provider skill library carries across the matrix without rewrites.
- **Phase 15 — Release Polish** *(shipped)*: `yaao doctor` audits Node + git versions, per-agent CLI availability, API provider keys, and orphan runs (status=running + journal stale + dead/missing pid). `yaao init` default-on registers yaao's MCP server in `.mcp.json` and auto-detects the repo's default branch via `git symbolic-ref refs/remotes/origin/HEAD`. README gains a six-line copy-paste Quickstart plus three runnable example plans under `examples/` (typescript-monorepo / python-flask / c-kernel). Every command's `--help` now reads as more than the bare verb, every documented `YaaoError` has a `DEFAULT_HINTS` entry, and a new `tests/phase-15/docs/links.test.ts` walks every markdown link in repo .md files so doc rot doesn't ship to users.
- **Phase 16 — Concurrent Runs & Context Handoff**: runId entropy + branch namespacing so two `yaao run`s against different feature branches don't collide, integration tests + docs alignment for the concurrent-runs workflow, and a `context.md` enrichment pass (parent prompt, validation outcome, commit chain, diff stat) so dependent agents get the meta-context they need on handover.
- **Phase 17 — Session → Skill Distillation**: capture useful patterns from a finished chat session and crystallise them into a reusable yaao skill via a new `yaao_distill` MCP tool.
- **Phase 18 — Distribution**: npm publish, docs site.

The README and the [implementation plan](docs/IMPLEMENTATION.md) remain the working spec.

---

## Why another orchestrator?

The space already has Spec Kit (plan-first workflow), various worktree experiments, and dozens of "Cursor rules" and "Claude skills" that try to standardize prompting. None of them tie the loop together end-to-end. yaao is opinionated about three things the others are not:

- **Plans are first-class build artifacts**, not prompts. They live in the repo, are versioned, and have a well-defined schema.
- **The execution plan is the source of truth** for what runs where. Per-step model, agent, skill, worktree, and merge policy live in the plan itself — not in CLI flags or environment variables.
- **Worktrees, not branches**, by default. This unlocks meaningfully parallel work on conflicting parts of the tree without IDE thrash.

---

## Core concepts

### Implementation plan

A human-readable description of *what* is to be built and *why*. Two supported formats:

- **Markdown** — a single `IMPLEMENTATION.md` (or numbered set: `01-foundation.md`, `02-api.md`…) with a light convention for phases, tasks, and dependencies.
- **Spec Kit** — `spec.md` + `plan.md` + `tasks.md` triplet, compatible with the upstream `specify` workflow.

Both formats can coexist in one project; the converter accepts either.

### Execution plan

A machine-runnable plan. **YAML** is the canonical format for v1 (JSON output is a post-MVP option). One execution plan can `include` others (sub-phases). Schema sketch:

```yaml
plan:
  name: my-feature
config:
  base-branch: main
  max-parallel: 4
  worktree-root: .yaao/worktrees
  merge:
    strategy: auto         # auto | pr | manual
    on-conflict: agent     # agent (default) | manual
  run:
    require-tracked-plan: error   # error (default) | warn | off
context:
  ctx-sys:
    enabled: true
    require-query: true    # agents MUST call context_query before writing code
tasks:
  - id: scaffold
    title: Scaffold project
    agent: claude-code
    model: opus
    skills: [yaao-implementer]
    prompt-ref: ./plans/scaffold.md
    files: [package.json, tsconfig.json, src/**]
    merge: auto

  - id: api
    title: Implement REST API
    depends: [scaffold]
    agent: cursor
    prompt-ref: ./plans/api.md

  - id: ui
    title: Implement UI
    depends: [scaffold]
    agent: api
    api:
      provider: anthropic
      model: claude-opus-4-7
    prompt-ref: ./plans/ui.md

  - id: integration-tests
    title: End-to-end tests
    depends: [api, ui]
    agent: codex
    merge: pr
```

Each step declares **what runs (`agent` / `model` / `skills`)**, **where it runs (`worktree`/`branch`)**, **what it depends on (`depends`)**, and **how it merges (`merge`)**. Parallelism falls out of the dependency DAG.

### Worktree-per-step

Every task gets its own git worktree on its own branch. Independent tasks run in physically separate working trees on disk so agents cannot stomp on each other. Dependent tasks branch from their parent's branch, so downstream agents see committed upstream work.

Worktree reuse across runs is keyed on `(planName, taskId, sha256(promptBody)[..16], sha256(canonical(depends))[..16])` — editing a task's prompt, changing its dependency list, or running a different plan that happens to share a task id, all invalidate the cache and force a fresh worktree. This makes resume safe across plan edits.

### Plan-tracking gate

`yaao run` refuses to start when the plan file isn't recorded in git (`run.require-tracked-plan: error`, the default). This keeps the audit trail closed end-to-end: every run's commits trace back to a recorded plan, not whatever you happened to have in your working tree. Escape hatches: `--commit-plan` (auto-commit the plan with a `[yaao] plan <name> (<runId>)` subject), `--allow-untracked-plan` (downgrade the gate to a warning), or `run.require-tracked-plan: off` in config.

### ctx-sys integration (optional)

[`ctx-sys`](../ctx-sys) is a local hybrid-RAG context system. yaao integrates with it cleanly but treats it as **completely optional** — yaao never depends on ctx-sys, never installs it, and the default config has it disabled.

When `context.ctx-sys.enabled: true`, yaao:

- Auto-spawns `ctx-sys serve` on a project-scoped socket for the duration of the run (toggleable; if you'd rather run it yourself, set `auto-spawn: false`).
- Registers ctx-sys as an MCP server alongside yaao's own MCP server, so every agent that connects to yaao's MCP also has `context_query` available.
- Prepends a system-prompt directive to every step: "Before writing or modifying code, call the `context_query` MCP tool to retrieve relevant context from this codebase."

ctx-sys is one example of an MCP context provider. yaao's MCP wiring is generic — you can plug in any MCP server you like via `context.mcp-servers:` and the same injection path applies.

---

## Installation

Currently no npm publish — clone and build from source (distribution lands in Phase 18):

```bash
git clone <repo> yaao
cd yaao
npm install
npm run build
npm link  # makes `yaao` available on $PATH
```

Requires Node ≥ 20, `bash` (used for `validation` / `setup` commands with `set -e -o pipefail`), `git` ≥ 2.40, and one or more of: `claude`, `cursor-agent`, `gh copilot`, `codex` on `$PATH` (depending on which agents you'll use). The `agent: api` backend uses the Anthropic API directly and only needs `ANTHROPIC_API_KEY` in the env.

---

## Quickstart

Five lines on a fresh checkout:

```bash
npm i -g yaao
cd my-project
yaao init                                  # writes .yaao/ + registers yaao's MCP server in .mcp.json
yaao doctor                                # confirm Node + git + agent CLIs + API keys all resolve
yaao plan "add a /healthz endpoint"        # uses your default agent
yaao convert .yaao/plans/healthz.md        # → .yaao/exec/healthz.yaml
yaao run .yaao/exec/healthz.yaml           # parallel worktrees, auto-merge
```

That's the whole flow. `yaao web` in another terminal opens a browser view of the live run. `yaao run --resume <run-id>` picks up after a failed task.

### Examples

Three runnable execution plans live under [`examples/`](examples/):

- [`examples/typescript-monorepo/healthz-endpoint.yaml`](examples/typescript-monorepo/healthz-endpoint.yaml) — 3-task fan-out under a `scaffold` parent, demonstrating per-task `validation.cwd` for monorepo workspaces.
- [`examples/python-flask/add-jwt-auth.yaml`](examples/python-flask/add-jwt-auth.yaml) — 4-task chain ending in a `merge: pr` step, mixing `claude-code` and `api` backends.
- [`examples/c-kernel/serial-driver.yaml`](examples/c-kernel/serial-driver.yaml) — hardware-adjacent multi-stage build with `setup:` commands and `merge: manual` so kernel work routes through a review queue rather than auto-merging.

Each example passes `yaao validate` cleanly; adapt the file paths and validation commands to your repo and run with `yaao run examples/<dir>/<file>.yaml`.

---

## CLI

| Command | Purpose |
|---|---|
| `yaao init` | Scaffold `.yaao/`, `yaao.config.json`, `.yaaoignore`, install agent skill files. |
| `yaao plan <description>` | Generate an implementation plan. `--format markdown\|speckit\|both`, `--scope feature\|project`, `--out <path>`. |
| `yaao convert <plan>` | Convert an implementation plan to an execution plan. `--infer-deps off\|suggest\|auto`. |
| `yaao validate <exec-plan>` | Schema + DAG validation, no execution. |
| `yaao view <exec-plan>` | Static plan inspection — prints the DAG, per-step config, and dependency edges to the terminal. No live monitoring. |
| `yaao run <exec-plan>` | Execute. Streams progress to stderr. Flags: `--max-parallel`, `--dry-run`, `--trial`, `--resume <run-id>`, `--only <ids>`, `--skip <ids>`, `--no-tui`, `--no-merge`, `--allow-untracked-plan`, `--commit-plan`, `--force`. |
| `yaao stop [run-id]` | Stop a running yaao run by sending SIGTERM to its runner process. The runner stamps `run:end status=cancelled` in the journal before exit; in-flight task branches survive (resume via `--resume`). Omit the run-id to target the most recent `status=running` run. |
| `yaao status [run-id]` | Inspect a run (live or completed). |
| `yaao clean [run-id]` | Tear down worktrees + branches. (For finer-grained control, use the `yaao_prune` MCP tool — same logic, structured input/output, dry-run by default.) |
| `yaao agents` | Report which agent backends are available and their versions. (Subsumed by `yaao doctor` in Phase 15.) |
| `yaao skills install` | (Re)install skill/agent files for Claude Code, Cursor, Copilot, Codex. |
| `yaao serve` | Start the MCP stdio server. Spawned by AI clients (Claude Code, Cursor, etc.) via their MCP config; not run directly by humans. |
| `yaao web` | Start the local HTTP+SSE web viewer. Defaults to `http://127.0.0.1:8787`. Flags: `--host`, `--port`, `--token`, `--no-open`. Non-loopback binds require `--token`. |

---

## Configuration: `yaao.config.json`

```json
{
  "$schema": "https://yaao.dev/schema/config.json",
  "version": 1,
  "defaults": {
    "agent": "claude-code",
    "model": "opus",
    "max-parallel": 4,
    "base-branch": "main",
    "worktree-root": ".yaao/worktrees"
  },
  "merge": {
    "strategy": "auto",
    "on-conflict": "agent",
    "history": "merge"
  },
  "run": {
    "require-tracked-plan": "error"
  },
  "agents": {
    "claude-code": { "enabled": true, "bin": "claude" },
    "cursor":      { "enabled": true, "bin": "cursor-agent" },
    "copilot":     { "enabled": true, "bin": "gh" },
    "codex":       { "enabled": true, "bin": "codex" },
    "api": {
      "providers": {
        "anthropic":  { "api-key": "${ANTHROPIC_API_KEY}" }
      }
    }
  },
  "ctx-sys": {
    "enabled": false,
    "auto-spawn": true
  },
  "mcp-servers": {},
  "plan": {
    "format": "markdown",
    "out-dir": ".yaao/plans",
    "exec-dir": ".yaao/exec"
  }
}
```

**Secret handling.** API keys must be referenced as `${ENV_VAR}`. yaao refuses to start if a literal key string is detected in `yaao.config.json`. Keys can also live in `.yaao/secrets.local.json` (gitignored by default).

---

## Agent compatibility — MCP-first

The integration story across Claude Code, Cursor, Copilot, Codex, and raw Anthropic API is built around a single primitive: **yaao itself is an MCP server**. Every agent connects to yaao the same way. Skills, planning, converting, running, and inspecting all happen through MCP tools yaao exposes.

This collapses the four-agent-format problem into a single problem: register yaao as an MCP server in each agent's config. The four agents converge on one surface.

### Backend support tiers

Each backend's MCP coverage and CLI surface evolves at its own pace. yaao's project-level commitment to each is tiered, so users can pick agents whose maturity matches their tolerance for breakage:

| Tier | Backends | Commitment |
|---|---|---|
| **Tier 1** | Claude Code | CI-tested every commit. Reference target. Breakage blocks releases. |
| **Tier 2** | Cursor, Codex | Smoke-tested per release against pinned versions. Issues triaged but may lag a release. |
| **Tier 3** | Copilot | Best-effort. The `gh copilot` agentic surface is the youngest of the four; expect breakage on Copilot-side updates and version-pinning workarounds. |
| **Tier 1 (separate path)** | API — Anthropic | Real (via native fetch). The same execution-plan / skill / merge surface as the CLI backends, with a separate in-process tool loop. OpenAI / OpenRouter providers are stubs; landing one of those is the next step on the API path. |

Tiering is about *operational commitment*, not feature scope — every backend gets the same execution-plan schema, the same MCP wiring, the same skills.

### The two roles yaao plays

yaao is both an MCP **server** (exposing tools to agents) and an MCP **client** (consuming tools from ctx-sys and any other context provider). When a task runs:

```text
┌──────────────────┐       MCP        ┌────────────────┐
│   agent backend  │ ◀──────────────▶ │  yaao server   │
│ (cc/cursor/cop/  │   tools, plans   │ (per-run stdio │
│  codex/api)      │   skill calls    │  or socket)    │
└──────────────────┘                  └───────┬────────┘
                                              │ MCP client
                                      ┌───────▼────────┐
                                      │ ctx-sys (opt.) │
                                      │ + user MCPs    │
                                      └────────────────┘
```

### Tools yaao exposes over MCP

The same surface used by `yaao serve` is what every agent sees:

| Tool | Mirrors | Purpose |
| --- | --- | --- |
| `yaao_plan`     | `yaao plan`     | Generate an implementation plan. |
| `yaao_convert`  | `yaao convert`  | Turn a plan into an execution plan. |
| `yaao_validate` | `yaao validate` | Validate an execution plan. |
| `yaao_run`      | `yaao run`      | Start a run; returns rich per-task summary. |
| `yaao_resume`   | `yaao run --resume` | Continue a prior run under the same runId. |
| `yaao_stop`     | `yaao stop`     | Cross-process cancel: send SIGTERM to the runner; the journal stamps `cancelled` and in-flight branches survive. |
| `yaao_status`   | `yaao status`   | Inspect a run. |
| `yaao_inspect`  | —               | One-call workspace snapshot: workspace, plans (with git-tracked state), runs (with branchesAlive). |
| `yaao_prune`    | `yaao clean`    | Structured cleanup with safety rails (dry-run by default, never touches base-branch, refuses worktrees with uncommitted changes without `force`). |
| `yaao_agents`   | `yaao agents`   | List available agent backends and versions. |
| `yaao_plans`    | —               | List plans + exec files. |
| `yaao_skill_<name>` | (skill body) | Each user-defined skill is exposed as a callable MCP tool. Hot-reloaded — new skills are callable within ~250 ms of being written to disk. |

A skill in `.yaao/skills/<name>/` becomes an MCP tool `yaao_skill_<name>` automatically. Authoring a skill is now: write `prompt.md` with declared inputs, save, every agent connected to yaao's MCP can call it without a reconnect.

### What `yaao skills install` does per agent

Per-agent files exist, but they're *thin*: each agent only needs to know that yaao's MCP server is available. The big content (skill bodies, system prompts, tool definitions) lives behind the MCP boundary, not duplicated four ways.

| Backend | What yaao writes | Bytes (typical) |
|---|---|---|
| `claude-code` | `.claude/yaao-mcp.json` (MCP server registration) + a one-paragraph note in `.claude/CLAUDE.md` | small |
| `cursor`      | Managed `ctx-sys` + `yaao` blocks in `.cursor/mcp.json` (preserved + restored if pre-existing) | small |
| `copilot`     | MCP config block + a one-paragraph stub in `.github/copilot-instructions.md` | small |
| `codex`       | MCP overlay in the per-run `~/.codex/config.toml` shadow + a managed block in `AGENTS.md` | small |
| `api`         | MCP client wiring is in-process; tools are registered directly on the SDK call. | n/a |

This is the part that changed compared to traditional skill-emitter approaches: the per-agent files are bootstraps that point at yaao's MCP server, not duplicated prompt content. When yaao adds a skill or changes a tool, every agent picks up the change without re-emission.

### When a backend doesn't speak MCP well

Each agent backend's MCP coverage is uneven (Copilot's MCP support is newest, Codex's is solid, Claude Code and Cursor have first-class support). For backends with weaker or evolving MCP support, the F4 backend layer falls back to inlining the relevant skill body into the prompt at spawn time. The MCP path is preferred; the inline path is the safety net.

### The two built-in skills

- **`yaao-planner`** — generates implementation plans. Surfaced as the `yaao_plan` MCP tool. Knows the markdown / Spec Kit conventions, knows how to scope to feature vs. project.
- **`yaao-converter`** — turns implementation plans into execution plans. Surfaced as the `yaao_convert` MCP tool. Knows the schema, infers dependencies from prose ("after the API exists…"), assigns sensible default agents per task.

---

## Worktree orchestration

- **Dependency-aware branching** — dependent tasks branch off the parent's branch, not `main`. Diamond DAGs merge multiple parents into the worktree before launching the agent.
- **Topological merge-back** — completed branches merge in dependency order to minimize conflicts. Auto-merge mode lands each task on base-branch as it completes; `--no-merge` leaves branches alone so you can review and PR them yourself.
- **Conflict resolution** — `agent` is the default for the (very common) parallel-sibling case: when sibling tasks both touch the same file, yaao respawns the executing agent on the conflict markers. `manual` stops the run for human resolution; `auto` only proceeds on a clean merge and never silently resolves. Configurable globally and per-step.
- **Validation gating** — a task with `validation.must-pass: true` whose pipeline exits non-zero **never** merges. The validation verdict is recorded on `task:completed` with `{exitCode, decisionReason, durationMs, mustPass}` so you can see why yaao decided pass/fail from `yaao_status` alone. Validation commands run under `bash -e -o pipefail`, so `make && nm build/kernel.elf | grep symbol` fails uniformly when any step in the pipe fails.
- **Resume** — runs are journaled to `.yaao/runs/<run-id>/`; `yaao run --resume <id>` (or `yaao_resume({runId})`) picks up after a crash. The same runId carries through start → fail → resume → success in one continuous timeline.

---

## TUI / monitoring

yaao ships a **text-mode** progress reporter, not a full interactive Ink dashboard. Two surfaces:

- **`yaao view <exec-plan>`** — prints the DAG, per-task agent/model/skills, and dependency edges to the terminal. Static, one-shot output.
- **`yaao run <exec-plan>`** — streams structured events to stderr as the run progresses: per-task state transitions (`▶ active`, `✔ completed`, `✖ failed`, `↪ merged`, etc.), tool-use captions, agent stdout, a ticker so a long-running task doesn't look hung. `--no-tui` switches off the live reporter; structured progress still lands in the journal at `.yaao/runs/<run-id>/journal.jsonl`.

For a browser-based experience, run **`yaao web`** from the project root. It serves an interactive DAG view, a live agent-activity stream (stdout / stderr / thinking / tool-use, filterable per task by clicking a DAG node), a workspace page wrapping `yaao_inspect` / `yaao_prune`, a YAML plan editor with syntax highlighting + a dependency-layer task navigator, a rendered implementation-plan source viewer (markdown), and a secrets-aware config editor — all with a built-in light/dark toggle. Defaults to `http://127.0.0.1:8787`; binds beyond loopback require `--token`. See [Running the web viewer](#running-the-web-viewer) below.

---

## Running the web viewer

`yaao web` is a separate process from `yaao serve` (the MCP stdio server). AI clients spawn `yaao serve`; humans run `yaao web` from a terminal. They share state through the filesystem — every process tails the run journal at `.yaao/runs/<id>/journal.jsonl`, so a run started by Claude Code via `yaao_run` is watchable in real time in the browser.

```bash
# From an installed yaao
yaao web                        # listens on http://127.0.0.1:8787 and opens a browser
yaao web --port 9000            # custom port
yaao web --no-open              # don't auto-open the browser
yaao web --host 0.0.0.0 --token $YAAO_WEB_TOKEN   # non-loopback binds REQUIRE --token
```

What you get in the browser:

- **Workspace** — wraps `yaao_inspect` + `yaao_prune` with a dry-run preview before each apply.
- **Plans** — lists every plan in the workspace, pairing the implementation-plan markdown (`.yaao/plans/*.md`) with its execution-plan YAML (`.yaao/exec/*.yaml`) by slug. Click a slug to open the interactive DAG, the plan-file path to view the rendered markdown source, or the exec path to open the YAML editor (syntax-highlighted, with a dependency-layer task navigator that scrolls the editor to the selected task; validation is server-side on save).
- **Latest run** — plan-panel-on-top, activity-stream-below layout. DAG nodes carry live status colour (running / completed / failed / skipped); clicking any node filters the activity stream to that task's stdout / stderr / thinking / tool-use events. Validation verdict and merge outcome surface inline on the selected task's metadata card. A red Stop button on running runs sends SIGTERM via the same primitive as `yaao stop`.
- **Config** — form view for the common knobs (defaults, merge, run gates, per-agent enable / bin / default-model, ctx-sys, API providers) plus a raw JSON view. Secrets only show `${ENV_VAR}` placeholders; the server rejects any save containing a literal API key.

### Running from a source checkout

The web bundle lives in a workspace under `web/`. Build it once before starting the engine, or use the dev server for HMR:

```bash
npm install        # installs root + web workspace deps
npm run build      # builds the engine and copies web/dist into dist/web
node dist/bin/yaao.js web

# OR — full hot-reload during development:
npm run dev:web    # Vite dev server on :5173, proxies /api to :8787
# in another terminal:
node dist/bin/yaao.js web --no-open --port 8787
# then open http://localhost:5173
```

### Auth model

- **Loopback (`127.0.0.1`)** — no auth. Local-user trust model; anyone who can hit your loopback already has shell.
- **Non-loopback** — `--token <hex>` is **required** at startup and must be presented as `Authorization: Bearer <token>` on every request. The browser app picks the token up from the query string on first load.

---

## Project layout (when initialized)

```text
your-project/
├── .yaao/
│   ├── yaao.config.json
│   ├── secrets.local.json        # gitignored
│   ├── plans/                    # implementation plans
│   ├── exec/                     # execution plans (yaml)
│   ├── skills/                   # source-of-truth for skills
│   ├── worktrees/                # transient, gitignored
│   └── runs/                     # journals
├── .yaaoignore
├── .claude/skills/yaao-*/        # generated by `yaao skills install`
├── .cursor/rules/yaao-*.mdc      # generated
├── .github/copilot-instructions.md  # appended to
├── .github/prompts/yaao-*.prompt.md # generated
└── AGENTS.md                     # appended to
```

---

## Stack

- **Language:** TypeScript, Node ≥ 20, ES modules.
- **CLI:** `commander`.
- **Config / schema:** `zod` + JSON Schema export for editor IntelliSense.
- **Plan parsing:** `yaml`.
- **Process orchestration:** `execa`.
- **Tests:** `vitest`.
- **MCP:** `@modelcontextprotocol/sdk` for client (talking to ctx-sys) and server (yaao-as-MCP).
- **Anthropic API:** native `fetch` (no SDK dependency).

---

## Implementation plan

The full phase-by-phase implementation plan lives in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md). Per-feature specs live under `docs/phase-N/`.

---

## Non-goals

- Replacing CI/CD. yaao is a developer-machine tool. Runs are local; merges are local until you push or open a PR.
- Hosted SaaS. yaao runs entirely on your machine; the only outbound traffic is to whichever model API you opt into.
- Being a code editor. Use Claude Code / Cursor / etc. for that. yaao orchestrates them.

---

## Prior art and acknowledgments

- [`ctx-sys`](../ctx-sys) — local hybrid-RAG context system; yaao's preferred context provider.
- [GitHub Spec Kit](https://github.com/github/spec-kit) — spec-first development workflow.
- [Anthropic Claude Code](https://claude.com/claude-code), [Cursor](https://cursor.com), [GitHub Copilot](https://github.com/features/copilot), [OpenAI Codex](https://github.com/openai/codex) — the agents yaao orchestrates.

---

## License

MIT — see [LICENSE](LICENSE).
