/**
 * Pure tool handlers used by the yaao MCP server. Each handler returns a structured
 * result + a content string (the latter is what an MCP client surfaces to a user).
 * Wiring into the SDK lives in src/mcp/server.ts.
 *
 * All tools build a common envelope (see {@link ToolEnvelope}) so MCP callers
 * can rely on `ok`, `files`, `warnings`, and `errors` being present everywhere
 * — even on the error path. Tool-specific keys (e.g. `tasks`, `runId`) ride
 * alongside the envelope rather than replacing it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { YaaoConfig } from '../config/types.js';
import {
  resolveSkill,
  substitutePlaceholders,
  listSkillDirs,
  validateSkill,
  type LoadedSkill,
} from '../skills/format.js';
import { getBuiltinSkillsDir } from '../skills/builtin-dir.js';
import { runPlanner } from '../planner/run.js';
import { convertPlan } from '../converter/convert.js';
import { loadPlan } from '../plan/yaml/loader.js';
import { runPlan } from '../exec/runner.js';
import { listRuns, loadRun } from '../git/journal.js';
import type { AgentBackend, AgentName } from '../agents/backend.js';
import { ClaudeCodeBackend } from '../agents/claude-code.js';
import { CursorBackend } from '../agents/cursor.js';
import { CopilotBackend } from '../agents/copilot.js';
import { CodexBackend } from '../agents/codex.js';
import { YaaoError } from '../log/errors.js';

/**
 * Common envelope every tool's `structuredContent` extends. Designed so a
 * caller can do `if (!r.ok) for (const e of r.errors) ...` without needing
 * per-tool knowledge of which field carries the failure.
 */
export interface ToolEnvelope {
  ok: boolean;
  files: { path: string; action: 'created' | 'overwrote' | 'unchanged' }[];
  warnings: string[];
  errors: { code: string; message: string; hint?: string }[];
}

/**
 * Wrap a tool body so that any thrown {@link YaaoError} becomes a structured
 * error envelope on `ok: false` rather than propagating out as an MCP-level
 * transport error. Anything else still bubbles up — those are real bugs.
 */
async function envelope(
  fn: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof YaaoError)) throw e;
    return errorResult(e);
  }
}

function errorResult(e: YaaoError): ToolCallResult {
  const err = { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  return {
    text: `${e.code}: ${e.message}${e.hint ? `\n  hint: ${e.hint}` : ''}`,
    structuredContent: {
      ok: false,
      files: [],
      warnings: [],
      errors: [err],
    },
  };
}

function relPath(cwd: string, p: string): string {
  const r = relative(cwd, p);
  return r.length > 0 && !r.startsWith('..') ? r : p;
}

export interface ToolContext {
  cwd: string;
  config: YaaoConfig;
  /** Override the backend factory (tests use this to inject a FakeBackend). */
  backendFor?: (agent: AgentName) => AgentBackend;
}

export interface ToolCallResult {
  /** Plain-text payload the MCP client should surface (e.g. via `content: [{ type: 'text' }]`). */
  text: string;
  /** Structured metadata. Returned via the MCP tool's `structuredContent`. */
  structuredContent: Record<string, unknown>;
}

/** ---- yaao_plan ----------------------------------------------------------------- */

export interface PlanToolInput {
  description: string;
  scope?: 'feature' | 'project';
  format?: 'markdown' | 'speckit' | 'both';
  out?: string;
  agent?: AgentName;
}

export async function yaaoPlanTool(input: PlanToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const agent = input.agent ?? ctx.config.defaults.agent;
    const backend = (ctx.backendFor ?? defaultBackendFor)(agent);
    const result = await runPlanner({
      cwd: ctx.cwd,
      config: ctx.config,
      description: input.description,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.format !== undefined ? { format: input.format } : {}),
      ...(input.out !== undefined ? { outDir: input.out } : {}),
      backend,
    });
    const files = result.files.map((f) => ({ path: relPath(ctx.cwd, f.path), action: f.action }));
    const created = files.filter((f) => f.action === 'created').length;
    const overwrote = files.filter((f) => f.action === 'overwrote').length;
    const unchanged = files.filter((f) => f.action === 'unchanged').length;
    const text =
      created + overwrote > 0
        ? `Wrote ${created + overwrote} plan file(s):\n${files
            .filter((f) => f.action !== 'unchanged')
            .map((f) => `  ${f.action === 'created' ? '+' : '~'} ${f.path}`)
            .join('\n')}`
        : unchanged > 0
          ? `No new plan files written; ${unchanged} existing plan file(s):\n${files
              .map((f) => `  = ${f.path}`)
              .join('\n')}`
          : '(no files written)';
    return {
      text,
      structuredContent: {
        ok: result.ok,
        files,
        warnings: result.warnings,
        errors: [],
        tasks: result.plan?.tasks.length ?? 0,
        scope: result.scope,
        format: result.format,
      },
    };
  });
}

/** ---- yaao_convert -------------------------------------------------------------- */

export interface ConvertToolInput {
  input: string;
  out?: string;
  inferDeps?: 'off' | 'suggest' | 'auto';
}

export async function yaaoConvertTool(input: ConvertToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const r = await convertPlan({
      cwd: ctx.cwd,
      config: ctx.config,
      input: input.input,
      ...(input.out !== undefined ? { out: input.out } : {}),
      ...(input.inferDeps !== undefined ? { infer: input.inferDeps } : {}),
    });
    const fileEntry = { path: relPath(ctx.cwd, r.outPath), action: r.outAction };
    // `inferDeps: 'auto'` returning `inferred: []` is ambiguous (nothing to
    // infer vs. inferrer gave up). Distinguish in the disposition string so the
    // caller doesn't have to guess.
    const inferDisposition =
      input.inferDeps === undefined
        ? 'skipped'
        : input.inferDeps === 'off'
          ? 'skipped'
          : r.inferred.length === 0
            ? 'no-candidates-found'
            : input.inferDeps === 'auto'
              ? 'applied'
              : 'suggested';
    return {
      text: `${r.outAction === 'created' ? 'Wrote' : 'Overwrote'} ${r.outPath} with ${r.plan.tasks.length} task(s).`,
      structuredContent: {
        ok: true,
        files: [fileEntry],
        warnings: r.warnings,
        errors: [],
        outPath: r.outPath,
        tasks: r.plan.tasks.length,
        inferred: r.inferred,
        inferDisposition,
      },
    };
  });
}

/** ---- yaao_validate ------------------------------------------------------------- */

export interface ValidateToolInput {
  plan: string;
}

export async function yaaoValidateTool(input: ValidateToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const planAbs = resolve(ctx.cwd, input.plan);
    if (!existsSync(planAbs)) {
      throw new YaaoError({ code: 'YAAO_PLAN_NOT_FOUND', message: `plan not found: ${planAbs}` });
    }
    const { validatePlan } = await import('../plan/validate/index.js');
    const loaded = await loadPlan(planAbs, { cwd: resolve(ctx.cwd), config: ctx.config });
    const issues = validatePlan(loaded.plan, loaded.source, {
      cwd: ctx.cwd,
      config: ctx.config,
    });
    const errs = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity !== 'error');
    return {
      text: errs.length === 0 ? '✔ plan ok' : `${errs.length} error(s); ${warns.length} warning(s)`,
      structuredContent: {
        ok: errs.length === 0,
        files: [{ path: relPath(ctx.cwd, planAbs), action: 'unchanged' as const }],
        warnings: warns.map((w) => w.message),
        errors: errs.map((e) => ({ code: e.code, message: e.message })),
        issues,
      },
    };
  });
}

/** ---- yaao_run + yaao_status ---------------------------------------------------- */

export interface RunToolInput {
  plan: string;
  only?: string[];
  skip?: string[];
  trial?: boolean;
  /**
   * Skip the post-task auto-merge into base-branch. Tasks land on their own
   * branches only. Caller gets `tasks[].branch` + `commit` in the response and
   * lands the work themselves (e.g. via `gh pr create`). Addresses the
   * big-blast-radius default of yaao_run merging straight into main.
   */
  noMerge?: boolean;
}

export async function yaaoRunTool(input: RunToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const planAbs = resolve(cwd, input.plan);
    const loaded = await loadPlan(planAbs, { cwd, config: ctx.config });
    const runId = `run-${Date.now().toString(36)}`;
    const result = await runPlan({
      runId,
      plan: loaded.plan,
      planFile: planAbs,
      rootDir: cwd,
      config: ctx.config,
      backendFor: (task) => (ctx.backendFor ?? defaultBackendFor)(task.agent),
      ...(input.only || input.skip
        ? { filter: { ...(input.only ? { only: input.only } : {}), ...(input.skip ? { skip: input.skip } : {}) } }
        : {}),
      ...(input.trial !== undefined ? { trial: input.trial } : {}),
      ...(input.noMerge !== undefined ? { noMerge: input.noMerge } : {}),
    });
    // Pull the full summary back out of the journal so we can emit a per-task
    // array without forcing a follow-up yaao_status call. The summary lives at
    // .yaao/runs/<runId>/summary.json and already has filesChanged, merge SHA,
    // and the cachedFromRunId we just plumbed in.
    const journalDir = join(cwd, '.yaao', 'runs');
    let tasks: unknown[] = [];
    let planCommit: string | undefined;
    let unmerged: { taskId: string; into: string; conflicts: string[] }[] = [];
    try {
      const { summary } = await loadRun(runId, journalDir);
      planCommit = summary.planCommit;
      tasks = Object.entries(summary.tasks).map(([id, t]) => ({
        id,
        status: t.status,
        ...(t.agent !== undefined ? { agent: t.agent } : {}),
        ...(t.branch !== undefined ? { branch: t.branch } : {}),
        ...(t.worktree !== undefined ? { worktree: t.worktree } : {}),
        ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
        ...(t.filesChanged !== undefined ? { filesChanged: t.filesChanged } : {}),
        ...(t.commit !== undefined ? { commit: t.commit } : {}),
        ...(t.mergeStatus !== undefined ? { mergeStatus: t.mergeStatus } : {}),
        ...(t.mergeInto !== undefined ? { mergeInto: t.mergeInto } : {}),
        ...(t.mergeCommit !== undefined ? { mergeCommit: t.mergeCommit } : {}),
        ...(t.mergeConflicts !== undefined ? { mergeConflicts: t.mergeConflicts } : {}),
        ...(t.mergeReason !== undefined ? { mergeReason: t.mergeReason } : {}),
        ...(t.cachedFromRunId !== undefined
          ? { cached: true, cachedFromRunId: t.cachedFromRunId }
          : {}),
      }));
      unmerged = Object.entries(summary.tasks)
        .filter(([, t]) => t.mergeStatus === 'merge-failed')
        .map(([id, t]) => ({
          taskId: id,
          into: t.mergeInto ?? '',
          conflicts: t.mergeConflicts ?? [],
        }));
    } catch {
      // Journal missing/corrupt — fall back to the bare envelope below.
    }
    const warnings: string[] = [];
    if (unmerged.length > 0) {
      warnings.push(
        `${unmerged.length} task(s) committed work but failed to merge: ${unmerged
          .map((u) => `${u.taskId} → ${u.into}`)
          .join(', ')}`,
      );
    }
    return {
      text: `run ${runId} ${result.status} in ${result.durationMs}ms`,
      structuredContent: {
        ok: result.status === 'success',
        files: [],
        warnings,
        errors: [],
        runId,
        status: result.status,
        durationMs: result.durationMs,
        ...(planCommit !== undefined ? { planCommit } : {}),
        tasks,
        unmerged,
      },
    };
  });
}

export interface StatusToolInput {
  runId?: string;
}

export async function yaaoStatusTool(input: StatusToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const journalDir = join(cwd, '.yaao', 'runs');
    const runs = await listRuns(journalDir);
    const target = input.runId ? runs.find((r) => r.runId === input.runId) : runs[0];
    if (!target) {
      throw new YaaoError({
        code: 'YAAO_NO_RUNS',
        message: 'no runs found',
        hint: input.runId
          ? `no run with id ${input.runId} in .yaao/runs/`
          : 'run `yaao run <plan.yaml>` first, or pass an explicit runId.',
      });
    }
    const { summary } = await loadRun(target.runId, journalDir);
    return {
      text: `run ${summary.runId} status=${summary.status}`,
      structuredContent: {
        ok: summary.status === 'success',
        files: [],
        warnings: [],
        errors: [],
        ...summary,
      },
    };
  });
}

/** ---- yaao_agents --------------------------------------------------------------- */

export async function yaaoAgentsTool(_input: Record<string, never>, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const { detectAgents } = await import('../agents/detect.js');
    const r = await detectAgents(ctx.config);
    const list: Record<string, { available: boolean; version?: string; reason?: string }> = {};
    for (const [name, report] of r.byName) {
      list[name] = {
        available: report.available,
        ...(report.version !== undefined ? { version: report.version } : {}),
        ...(report.reason !== undefined ? { reason: report.reason } : {}),
      };
    }
    return {
      text: Object.entries(list)
        .map(([k, v]) => `${v.available ? '✔' : '✘'} ${k}`)
        .join('\n'),
      structuredContent: { ok: true, files: [], warnings: [], errors: [], agents: list },
    };
  });
}

/** ---- yaao_plans ---------------------------------------------------------------- */

export async function yaaoPlansTool(_input: Record<string, never>, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const plansDir = join(cwd, '.yaao', 'plans');
    const execDir = join(cwd, '.yaao', 'exec');
    const planFiles: string[] = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith('.md'))
      : [];
    const execFiles: string[] = existsSync(execDir)
      ? readdirSync(execDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      : [];
    // Surface mtime per file plus whether each plan has a paired exec YAML.
    // Saves callers from having to ls + read YAML to know the workspace state.
    const execSlugs = new Set(execFiles.map((f) => f.replace(/\.ya?ml$/, '')));
    const plans = planFiles.map((f) => {
      const abs = join(plansDir, f);
      const slug = f.replace(/\.md$/, '');
      return {
        path: relPath(cwd, abs),
        mtimeMs: safeMtimeMs(abs),
        hasExec: execSlugs.has(slug),
      };
    });
    const planSlugs = new Set(planFiles.map((f) => f.replace(/\.md$/, '')));
    const exec = execFiles.map((f) => {
      const abs = join(execDir, f);
      const slug = f.replace(/\.ya?ml$/, '');
      return {
        path: relPath(cwd, abs),
        mtimeMs: safeMtimeMs(abs),
        hasPlan: planSlugs.has(slug),
      };
    });
    const files = [
      ...plans.map((p) => ({ path: p.path, action: 'unchanged' as const })),
      ...exec.map((p) => ({ path: p.path, action: 'unchanged' as const })),
    ];
    return {
      text: `plans: ${plans.length}\nexec: ${exec.length}`,
      structuredContent: {
        ok: true,
        files,
        warnings: [],
        errors: [],
        plans,
        exec,
      },
    };
  });
}

function safeMtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** ---- yaao_skill_<name>  -------------------------------------------------------- */

export interface SkillToolInput {
  [k: string]: string | undefined;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Property-name → required flag for input validation hints. */
  inputs: { name: string; description?: string; required: boolean; default?: string }[];
}

export function discoverSkills(ctx: ToolContext): DiscoveredSkill[] {
  const builtinDir = getBuiltinSkillsDir();
  const dirs = listSkillDirs({
    cwd: ctx.cwd,
    skipUser: false,
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  const out: DiscoveredSkill[] = [];
  for (const d of dirs) {
    try {
      const skill = resolveSkill(d.name, {
        cwd: ctx.cwd,
        skipUser: false,
        ...(builtinDir !== undefined ? { builtinDir } : {}),
      });
      if (!skill) continue;
      const v = validateSkill(skill);
      if (!v.ok) continue;
      out.push({
        name: skill.metadata.name,
        description: skill.metadata.description,
        inputs: skill.metadata.inputs.map((i) => ({
          name: i.name,
          ...(i.description !== undefined ? { description: i.description } : {}),
          required: i.required ?? false,
          ...(i.default !== undefined ? { default: i.default } : {}),
        })),
      });
    } catch {
      // Skip malformed skills; surface separately via `yaao skills validate`.
    }
  }
  return out;
}

export function yaaoSkillTool(skillName: string, input: SkillToolInput, ctx: ToolContext): ToolCallResult {
  const builtinDir = getBuiltinSkillsDir();
  const skill: LoadedSkill | undefined = resolveSkill(skillName, {
    cwd: ctx.cwd,
    ...(builtinDir !== undefined ? { builtinDir } : {}),
  });
  if (!skill) {
    return errorResult(
      new YaaoError({
        code: 'YAAO_SKILL_NOT_FOUND',
        message: `skill not found: ${skillName}`,
        hint: 'Run `yaao skills list` to see registered skills, or check .yaao/skills/.',
      }),
    );
  }
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) values[k] = v;
  const body = substitutePlaceholders(skill.prompt, values, skill.metadata.inputs);
  return {
    text: body,
    structuredContent: {
      ok: true,
      files: [],
      warnings: [],
      errors: [],
      skill: skill.metadata.name,
      version: skill.metadata.version,
      inputs: values,
    },
  };
}

/** Read a skill body to support tests / debugging without invoking the tool. */
export function readBuiltinSkill(name: string): string | undefined {
  const dir = getBuiltinSkillsDir();
  if (!dir) return undefined;
  const p = join(dir, name, 'prompt.md');
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8');
}

function defaultBackendFor(agent: AgentName): AgentBackend {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeBackend();
    case 'cursor':
      return new CursorBackend();
    case 'copilot':
      return new CopilotBackend();
    case 'codex':
      return new CodexBackend();
    case 'api':
      throw new YaaoError({
        code: 'YAAO_MCP_API_BACKEND_UNSUPPORTED',
        message: 'the api backend is not supported via yaao serve in MVP; use a CLI agent',
      });
  }
}
