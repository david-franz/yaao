# yaao — yet another agent orchestrator

> Plan it. Convert it. Run it in parallel worktrees. Across any agent you like.

`yaao` is a CLI for the full lifecycle of multi-agent software work:

1. **Plan** — generate implementation plans (plain markdown, [Spec Kit](https://github.com/github/spec-kit) format, or both) for either a single feature in an existing codebase or a green-field project across many subdirectories and phases.
2. **Convert** — turn any implementation plan (one yaao made or one you wrote yourself) into a deterministic, machine-runnable **execution plan** in YAML, with explicit step dependencies.
3. **Run** — execute the plan across multiple agents in parallel using **git worktrees** (one worktree per task), with merging back to a base branch.
4. **Watch** — monitor progress in a TUI today, a web viewer later.

It is editor- and agent-agnostic: every step in an execution plan can be assigned to **Claude Code**, **Cursor**, **GitHub Copilot**, **Codex**, or a raw **API model** (Anthropic, OpenAI, OpenRouter, etc.). It integrates natively with [`ctx-sys`](../ctx-sys) for context retrieval when configured — agents are explicitly directed to query ctx-sys before writing code.

---

## Status

Early design. This README and the [implementation plan](docs/IMPLEMENTATION.md) are the working spec. Nothing is built yet.

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
    on-conflict: manual    # manual (default) | agent
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

### ctx-sys integration

If `context.ctx-sys.enabled: true` and `ctx-sys` is initialized in the project, yaao:

- Auto-spawns `ctx-sys serve` on a project-scoped socket if not already running (no long-running daemon required).
- Injects an MCP connection into each agent's launch config (Claude Code `--mcp-config`, Cursor `mcp.json`, Codex `~/.codex/config.toml`, raw API tool definitions).
- Prepends a system-prompt directive to every step: "Before writing or modifying code, call the `context_query` MCP tool to retrieve relevant context from this codebase."
- When `require-query: true`, yaao will fail a step that produces a diff without having issued at least one `context_query` call (verified via MCP usage logs).

---

## Installation

```bash
npm install -g yaao
# or, per-project
npm install -D yaao
```

Requires Node ≥ 20, `git` ≥ 2.40, and one or more of: `claude`, `cursor-agent`, `gh copilot`, `codex` on `$PATH` (depending on which agents you'll use).

---

## Quick start

```bash
# 1. Initialize
yaao init
# creates .yaao/yaao.config.json and .yaaoignore

# 2. Generate an implementation plan for a new feature
yaao plan "Add OAuth2 login with Google and GitHub" --format markdown

# 3. Convert it to an execution plan
yaao convert .yaao/plans/oauth.md

# 4. Inspect the DAG before running
yaao view .yaao/exec/oauth.yaml

# 5. Run it
yaao run .yaao/exec/oauth.yaml
```

---

## CLI

| Command | Purpose |
|---|---|
| `yaao init` | Scaffold `.yaao/`, `yaao.config.json`, `.yaaoignore`, install agent skill files. |
| `yaao plan <description>` | Generate an implementation plan. `--format markdown\|speckit\|both`, `--scope feature\|project`, `--out <path>`. |
| `yaao convert <plan>` | Convert an implementation plan to an execution plan. `--split` to emit phase files. |
| `yaao validate <exec-plan>` | Schema + DAG validation, no execution. |
| `yaao view <exec-plan>` | Static TUI viewer (web later). Shows DAG, per-step config, dependency edges. |
| `yaao run <exec-plan>` | Execute. Live TUI dashboard. `--max-parallel`, `--dry-run`, `--resume <run-id>`, `--only <ids>`, `--skip <ids>`, `--no-tui`. |
| `yaao status [run-id]` | Inspect a run (live or completed). |
| `yaao merge [run-id]` | Merge completed worktrees in topo order. `--pr`, `--target`, `--auto-resolve`. |
| `yaao clean [run-id]` | Tear down worktrees + branches. |
| `yaao agents` | List detected agent backends and their availability. |
| `yaao skills install` | (Re)install skill/agent files for Claude Code, Cursor, Copilot, Codex. |
| `yaao doctor` | Diagnose environment: git version, agent availability, ctx-sys status, config sanity. |

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
    "on-conflict": "manual",
    "conflict-resolver": { "agent": "claude-code", "model": "sonnet" }
  },
  "agents": {
    "claude-code": { "enabled": true, "bin": "claude" },
    "cursor":      { "enabled": true, "bin": "cursor-agent" },
    "copilot":     { "enabled": true, "bin": "gh" },
    "codex":       { "enabled": true, "bin": "codex" },
    "api": {
      "providers": {
        "anthropic":  { "api-key": "${ANTHROPIC_API_KEY}" },
        "openai":     { "api-key": "${OPENAI_API_KEY}" },
        "openrouter": { "api-key": "${OPENROUTER_API_KEY}" }
      }
    }
  },
  "ctx-sys": {
    "enabled": true,
    "auto-spawn": true,
    "require-query": true
  },
  "plan": {
    "format": "markdown",
    "speckit": false
  }
}
```

**Secret handling.** API keys must be referenced as `${ENV_VAR}`. yaao refuses to start if a literal key string is detected in `yaao.config.json`. Keys can also live in `.yaao/secrets.local.json` (gitignored by default).

---

## Agent abstraction

yaao normalizes five very different things behind one `AgentBackend` interface:

| Backend | How it's invoked | Skill format |
|---|---|---|
| `claude-code` | `claude --print` (one-shot) or interactive session | `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md` |
| `cursor`      | `cursor-agent --print` | `.cursor/rules/<name>.mdc` |
| `copilot`     | `gh copilot` agent mode | `.github/copilot-instructions.md`, `.github/prompts/*.prompt.md` |
| `codex`       | `codex exec` | `AGENTS.md` |
| `api`         | direct SDK call (Anthropic / OpenAI / OpenRouter) | inline prompt + tools |

`yaao skills install` writes the right files into the right places for whichever agents the project uses, so a "skill" you author once is callable from any of them. Under the hood these are different artifacts; yaao keeps them in sync from a single source of truth in `.yaao/skills/<name>/`.

### The two built-in skills

- **`yaao-planner`** — generates implementation plans. Knows to query `ctx-sys` for codebase context, knows the markdown / Spec Kit conventions, knows how to scope to feature vs. project.
- **`yaao-converter`** — turns implementation plans into execution plans. Knows the schema, infers dependencies from prose ("after the API exists…"), assigns sensible default agents per task.

---

## Worktree orchestration

- **Dependency-aware branching** — dependent tasks branch off the parent's branch, not `main`. Diamond DAGs merge multiple parents into the worktree before launching the agent.
- **Topological merge-back** — completed branches merge in dependency order to minimize conflicts.
- **Conflict resolution** — `manual` is the default: yaao stops on conflict and lets the human resolve it. Opt-in modes are `agent` (spawn a resolver agent on the markers) and `auto` (only if the merge is clean — never silently resolves). Configurable globally and per-step.
- **Merge policies per task** — `auto` (merge to base), `pr` (push + `gh pr create`), `none` (keep the worktree, no merge).
- **Resume** — runs are journaled to `.yaao/runs/<run-id>.json`; `yaao run --resume <id>` picks up after a crash.

---

## TUI viewer / monitor

Built with [Ink](https://github.com/vadimdemedes/ink). Two distinct surfaces:

- **`yaao view`** — static DAG inspection. Shows nodes, edges, per-task agent/model/skills, estimated parallelism width. No execution.
- **`yaao run`** — live monitor. Task table (status, agent, branch, duration, files changed, last output line) plus a per-task log pane. `↑↓` select, `enter` log, `r` retry failed, `q` quit.

A web viewer is on the roadmap but explicitly not in the MVP.

---

## Project layout (when initialized)

```
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

## Architecture (intended)

```
┌──────────────────────────────────────────────────────────────────┐
│                            yaao CLI                              │
├──────────────────────────────────────────────────────────────────┤
│  init │ plan │ convert │ validate │ view │ run │ status │ merge │
└──────────────┬─────────────────────┬─────────────┬───────────────┘
               │                     │             │
       ┌───────▼────────┐    ┌───────▼────────┐    │
       │ Skill emitters │    │ Plan compiler  │    │
       │ (cc/cursor/    │    │ md/speckit →   │    │
       │  copilot/codex)│    │ exec yaml      │    │
       └────────────────┘    └────────────────┘    │
                                                   │
                              ┌────────────────────▼────────────────┐
                              │           Execution engine          │
                              │  ┌────────────────────────────────┐ │
                              │  │ DAG scheduler (topological,    │ │
                              │  │ parallelism-bounded)           │ │
                              │  └─────────────┬──────────────────┘ │
                              │                │                    │
                              │  ┌─────────────▼──────────────────┐ │
                              │  │ Worktree manager               │ │
                              │  │ (per-task branch + worktree)   │ │
                              │  └─────────────┬──────────────────┘ │
                              │                │                    │
                              │  ┌─────────────▼──────────────────┐ │
                              │  │ Agent runtime                  │ │
                              │  │ ┌────────┐ ┌──────┐ ┌────────┐ │ │
                              │  │ │ claude │ │cursor│ │copilot │ │ │
                              │  │ └────────┘ └──────┘ └────────┘ │ │
                              │  │ ┌────────┐ ┌──────────────┐    │ │
                              │  │ │ codex  │ │ api (sdk)    │    │ │
                              │  │ └────────┘ └──────────────┘    │ │
                              │  └─────────────┬──────────────────┘ │
                              │                │                    │
                              │  ┌─────────────▼──────────────────┐ │
                              │  │ Merge engine (auto / pr /      │ │
                              │  │ manual / agent-resolved)       │ │
                              │  └────────────────────────────────┘ │
                              └────────────┬─────────────────┬──────┘
                                           │                 │
                              ┌────────────▼────┐    ┌───────▼───────┐
                              │ ctx-sys (MCP)   │    │ TUI dashboard │
                              │ optional        │    │ (Ink)         │
                              └─────────────────┘    └───────────────┘
```

---

## Stack

- **Language:** TypeScript, Node ≥ 20, ES modules.
- **CLI:** `commander`.
- **Config / schema:** `zod` + JSON Schema export for editor IntelliSense.
- **Plan parsing:** `yaml`, `remark` (markdown), `gray-matter`.
- **Process orchestration:** `execa`, `eventemitter3`.
- **TUI:** `ink` + `ink-spinner` + a small DAG renderer.
- **Tests:** `vitest`.
- **MCP:** `@modelcontextprotocol/sdk` for client (talking to ctx-sys) and server (yaao-as-MCP).

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

TBD (likely MIT).
