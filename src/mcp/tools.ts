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
import { listRuns, loadRun, type RunSummary } from '../git/journal.js';
import { git as defaultGit, type Git } from '../git/git.js';
import { configPaths } from '../config/loader.js';
import { hashKey, WorktreeManager } from '../git/worktree-manager.js';
import type { AgentBackend, AgentName } from '../agents/backend.js';
import { rmSync } from 'node:fs';
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
  /** Override the git wrapper (tests use this to drive yaao_inspect/yaao_prune). */
  git?: Git;
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

/** ---- yaao_inspect -------------------------------------------------------------- */

export interface InspectToolInput {
  /** Restrict the response to a single plan slug; omit for the full workspace snapshot. */
  slug?: string;
}

/**
 * Single-call workspace snapshot — joins plan files, exec files, run journals,
 * and git state so a caller landing cold in a workspace doesn't have to
 * triangulate via `ls` + `git status` + reading YAML.
 *
 * Intentionally read-only and cheap. Validation status is NOT computed here
 * (would force a full plan-load per slug); callers wanting that should call
 * yaao_validate explicitly.
 */
export async function yaaoInspectTool(input: InspectToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const git = ctx.git ?? defaultGit;
    const plansDir = join(cwd, '.yaao', 'plans');
    const execDir = join(cwd, '.yaao', 'exec');
    const runsDir = join(cwd, '.yaao', 'runs');

    const planFiles = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith('.md'))
      : [];
    const execFiles = existsSync(execDir)
      ? readdirSync(execDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      : [];

    const inRepo = await git.isRepo(cwd);
    const allRuns = await listRuns(runsDir);

    // Index runs by the plan slug they ran against (matched on the plan file's
    // basename). Lets each plan row report a `lastRun*` triple without a
    // second scan.
    const runsBySlug = new Map<string, typeof allRuns>();
    for (const r of allRuns) {
      const planSlug = r.planFile ? slugFromPath(r.planFile) : '';
      const arr = runsBySlug.get(planSlug) ?? [];
      arr.push(r);
      runsBySlug.set(planSlug, arr);
    }

    const execBySlug = new Map<string, string>();
    for (const f of execFiles) execBySlug.set(slugFromPath(f), join(execDir, f));

    // Build plan rows. The slug is the plan file's basename without extension;
    // an exec file with the same slug is reported as the pair.
    const planSlugs = new Set<string>();
    for (const f of planFiles) planSlugs.add(slugFromPath(f));
    for (const slug of execBySlug.keys()) planSlugs.add(slug);

    const wantSlugs = input.slug ? new Set([input.slug]) : planSlugs;
    const plans: Record<string, unknown>[] = [];

    for (const slug of wantSlugs) {
      if (!planSlugs.has(slug)) continue;
      const planAbs = planFiles.includes(`${slug}.md`) ? join(plansDir, `${slug}.md`) : undefined;
      const execAbs = execBySlug.get(slug);
      const row: Record<string, unknown> = { slug };
      if (planAbs !== undefined) {
        row['planPath'] = relPath(cwd, planAbs);
        row['planMtimeMs'] = safeMtimeMs(planAbs);
        row['planHash'] = safeHash(planAbs);
        if (inRepo) {
          const planRel = relative(cwd, planAbs);
          // eslint-disable-next-line no-await-in-loop -- per-file probes are sequential
          const state = await git.planFileState(planRel, cwd);
          row['tracked'] = state.tracked && !state.dirty;
          row['dirty'] = state.dirty;
          // eslint-disable-next-line no-await-in-loop -- per-file probes are sequential
          row['planCommit'] = (await git.lastCommitFor(planRel, cwd)) ?? null;
        }
      }
      if (execAbs !== undefined) {
        row['execPath'] = relPath(cwd, execAbs);
        row['execMtimeMs'] = safeMtimeMs(execAbs);
        row['execHash'] = safeHash(execAbs);
        if (inRepo) {
          const execRel = relative(cwd, execAbs);
          // eslint-disable-next-line no-await-in-loop -- per-file probes are sequential
          const state = await git.planFileState(execRel, cwd);
          row['execTracked'] = state.tracked && !state.dirty;
          // eslint-disable-next-line no-await-in-loop -- per-file probes are sequential
          row['execCommit'] = (await git.lastCommitFor(execRel, cwd)) ?? null;
        }
      }
      const slugRuns = runsBySlug.get(slug) ?? [];
      // listRuns returns newest-first.
      const last = slugRuns[0];
      if (last) {
        row['lastRunId'] = last.runId;
        row['lastRunStatus'] = last.status;
        if (last.endedAt) row['lastRunEndedAt'] = last.endedAt;
      }
      plans.push(row);
    }

    // Build run rows with task-status counts and live-branch joins.
    const runs: Record<string, unknown>[] = [];
    for (const r of allRuns) {
      const taskEntries = Object.values(r.tasks);
      let completed = 0;
      let failed = 0;
      let skipped = 0;
      const branchSet = new Set<string>();
      for (const t of taskEntries) {
        if (t.status === 'completed') completed += 1;
        else if (t.status === 'failed') failed += 1;
        else if (t.status === 'skipped') skipped += 1;
        if (t.branch) branchSet.add(t.branch);
      }
      const branchesAlive: string[] = [];
      if (inRepo) {
        for (const b of branchSet) {
          // eslint-disable-next-line no-await-in-loop -- one branch probe at a time
          if (await git.branchExists(b, cwd)) branchesAlive.push(b);
        }
      }
      runs.push({
        runId: r.runId,
        planSlug: slugFromPath(r.planFile),
        status: r.status,
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        tasksTotal: taskEntries.length,
        tasksCompleted: completed,
        tasksFailed: failed,
        tasksSkipped: skipped,
        worktreeRoot: ctx.config.defaults['worktree-root'],
        branchesAlive,
      });
    }

    const cfgPaths = configPaths(cwd);
    const workspace = {
      cwd,
      configPath: cfgPaths.project ?? cfgPaths.global ?? null,
      baseBranch: ctx.config.defaults['base-branch'],
      defaultAgent: ctx.config.defaults.agent,
      worktreeRoot: ctx.config.defaults['worktree-root'],
      inRepo,
    };

    const text = [
      `workspace: ${workspace.cwd}`,
      `  base-branch: ${workspace.baseBranch}, default-agent: ${workspace.defaultAgent}`,
      `plans: ${plans.length}`,
      `runs: ${runs.length}`,
    ].join('\n');

    return {
      text,
      structuredContent: {
        ok: true,
        files: [],
        warnings: [],
        errors: [],
        workspace,
        plans,
        runs,
      },
    };
  });
}

/** ---- yaao_prune ---------------------------------------------------------------- */

export type PruneTarget = 'run' | 'plan' | 'all-completed' | 'all-failed' | 'older-than';
export type PruneScope = 'worktrees' | 'branches' | 'runs';

export interface PruneToolInput {
  target: PruneTarget;
  runId?: string;
  planSlug?: string;
  olderThanDays?: number;
  scope?: PruneScope[];
  /** Preview only. Defaults to true — destructive defaults are not the right shape for an MCP tool. */
  dryRun?: boolean;
  /** Required to remove worktrees with uncommitted changes (or other safety-net-tripping cases). */
  force?: boolean;
}

interface PruneSkip {
  kind: 'worktree' | 'branch' | 'runDir';
  path: string;
  reason: string;
}

interface PruneRemoved {
  worktrees: string[];
  branches: string[];
  runDirs: string[];
}

/**
 * Structured cleanup. Targets a set of runs (or a plan's runs, or all
 * completed/failed/older-than runs) and removes some scope of artifacts from
 * each. Safety rails:
 *
 *   - dryRun: true by default — preview only, never destructive on the first call.
 *   - Refuses to delete base-branch (configured `defaults.base-branch`).
 *   - Refuses to remove a worktree whose working tree has uncommitted changes
 *     unless force: true. Same for branches not merged into their mergeInto.
 *   - Survives partial failure: each removal is independent; failures are
 *     collected in `errors[]` and the rest of the work still happens.
 */
export async function yaaoPruneTool(input: PruneToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const git = ctx.git ?? defaultGit;
    const baseBranch = ctx.config.defaults['base-branch'];
    const worktreeRoot = ctx.config.defaults['worktree-root'];
    const journalDir = join(cwd, '.yaao', 'runs');
    const scope: PruneScope[] =
      input.scope && input.scope.length > 0 ? input.scope : ['worktrees', 'branches', 'runs'];
    // dryRun default = true. Destructive defaults are wrong for an MCP tool;
    // callers explicitly pass dryRun: false to mutate.
    const dryRun = input.dryRun ?? true;
    const force = input.force ?? false;

    const all = await listRuns(journalDir);
    const targets = pickPruneTargets(all, input);
    if (targets.length === 0) {
      return pruneResult(dryRun, { worktrees: [], branches: [], runDirs: [] }, [], [
        {
          code: 'YAAO_PRUNE_NO_MATCH',
          message: `no runs matched target=${input.target}`,
          hint:
            input.target === 'run'
              ? 'pass an existing runId — see yaao_inspect().runs'
              : input.target === 'plan'
                ? 'pass an existing planSlug — see yaao_inspect().plans'
                : 'no runs in .yaao/runs/ match the target',
        },
      ]);
    }

    const removed: PruneRemoved = { worktrees: [], branches: [], runDirs: [] };
    const skipped: PruneSkip[] = [];
    const errors: { code: string; message: string; hint?: string }[] = [];

    const wtManager = new WorktreeManager({ git, rootDir: cwd, worktreeRoot });
    const knownWorktrees = await wtManager.list();
    const worktreesByRunId = new Map<string, typeof knownWorktrees>();
    for (const w of knownWorktrees) {
      if (!w.sourceRunId) continue;
      const arr = worktreesByRunId.get(w.sourceRunId) ?? [];
      arr.push(w);
      worktreesByRunId.set(w.sourceRunId, arr);
    }

    for (const target of targets) {
      if (scope.includes('worktrees')) {
        for (const w of worktreesByRunId.get(target.runId) ?? []) {
          // Refuse to remove a worktree with uncommitted changes unless force.
          let dirty = false;
          try {
            dirty = await git.hasUncommitted(w.path);
          } catch {
            // worktree may have been removed manually — proceed with deletion.
          }
          if (dirty && !force) {
            skipped.push({
              kind: 'worktree',
              path: w.path,
              reason: 'uncommitted-changes',
            });
            continue;
          }
          if (dryRun) {
            removed.worktrees.push(w.path);
            continue;
          }
          try {
            await wtManager.remove(w.taskId, { force: true });
            removed.worktrees.push(w.path);
          } catch (e) {
            errors.push({
              code: 'YAAO_PRUNE_WORKTREE',
              message: `failed to remove worktree ${w.path}: ${(e as Error).message}`,
            });
          }
        }
      }
      if (scope.includes('branches')) {
        for (const [taskId, t] of Object.entries(target.tasks)) {
          const branch = t.branch;
          if (!branch) continue;
          if (branch === baseBranch) {
            // Hard rule: never delete the configured base-branch, no matter
            // what the journal claims a task ran on.
            skipped.push({
              kind: 'branch',
              path: branch,
              reason: `is-base-branch (refusing to delete ${baseBranch})`,
            });
            continue;
          }
          // Refuse to delete branches with unmerged commits unless force.
          // A task whose mergeStatus is 'merged' is safe; anything else
          // (failed, merge-failed, never-merged) is preserved by default.
          if (!force && t.mergeStatus !== 'merged') {
            skipped.push({
              kind: 'branch',
              path: branch,
              reason: t.mergeStatus === 'merge-failed' ? 'unmerged-commits' : 'never-merged',
            });
            continue;
          }
          if (dryRun) {
            removed.branches.push(branch);
            continue;
          }
          try {
            await git.deleteBranch(branch, { force: true }, cwd);
            removed.branches.push(branch);
          } catch (e) {
            errors.push({
              code: 'YAAO_PRUNE_BRANCH',
              message: `failed to delete branch ${branch} (task ${taskId}): ${(e as Error).message}`,
            });
          }
        }
      }
      if (scope.includes('runs')) {
        const runPath = join(journalDir, target.runId);
        if (dryRun) {
          removed.runDirs.push(runPath);
        } else {
          try {
            rmSync(runPath, { recursive: true, force: true });
            removed.runDirs.push(runPath);
          } catch (e) {
            errors.push({
              code: 'YAAO_PRUNE_RUNDIR',
              message: `failed to remove run dir ${runPath}: ${(e as Error).message}`,
            });
          }
        }
      }
    }

    return pruneResult(dryRun, removed, skipped, errors);
  });
}

function pruneResult(
  dryRun: boolean,
  removed: PruneRemoved,
  skipped: PruneSkip[],
  errors: { code: string; message: string; hint?: string }[],
): ToolCallResult {
  const summary = `${dryRun ? '(dry-run) ' : ''}removed: ${removed.worktrees.length} worktree(s), ${removed.branches.length} branch(es), ${removed.runDirs.length} run dir(s)`;
  return {
    text: skipped.length > 0 ? `${summary}; skipped ${skipped.length}` : summary,
    structuredContent: {
      ok: errors.length === 0,
      files: [],
      warnings: skipped.map((s) => `${s.kind} ${s.path}: ${s.reason}`),
      errors,
      dryRun,
      removed,
      skipped,
    },
  };
}

function pickPruneTargets(all: RunSummary[], input: PruneToolInput): RunSummary[] {
  switch (input.target) {
    case 'run':
      return input.runId ? all.filter((r) => r.runId === input.runId) : [];
    case 'plan':
      return input.planSlug
        ? all.filter((r) => slugFromPath(r.planFile) === input.planSlug)
        : [];
    case 'all-completed':
      return all.filter((r) => r.status === 'success');
    case 'all-failed':
      return all.filter((r) => r.status === 'failed' || r.status === 'cancelled');
    case 'older-than': {
      const days = input.olderThanDays;
      if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) return [];
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return all.filter((r) => {
        const stamp = r.endedAt ?? r.startedAt;
        const ms = stamp ? Date.parse(stamp) : 0;
        return ms > 0 && ms < cutoff;
      });
    }
  }
}

function slugFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.(md|ya?ml)$/, '');
}

function safeHash(p: string): string | undefined {
  try {
    return hashKey(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
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
