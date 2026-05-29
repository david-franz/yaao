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

import { existsSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
import { signalRun } from '../exec/signal-run.js';
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
import { YaaoError, AgentDisabledError } from '../log/errors.js';
import { isAgentEnabled } from '../config/enabled-agents.js';

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
  /** Written verbatim into the generated YAML as `plan.featureBranch`.
   * Absent → field omitted; the plan author can add it later by hand. */
  featureBranch?: string;
}

export async function yaaoConvertTool(input: ConvertToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const r = await convertPlan({
      cwd: ctx.cwd,
      config: ctx.config,
      input: input.input,
      ...(input.out !== undefined ? { out: input.out } : {}),
      ...(input.inferDeps !== undefined ? { infer: input.inferDeps } : {}),
      ...(input.featureBranch !== undefined ? { featureBranch: input.featureBranch } : {}),
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
        featureBranch: r.plan.plan.featureBranch ?? null,
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
    const extraWarnings: string[] = [];
    // Surface a typo-catching warning when plan.featureBranch is set but the
    // named branch doesn't exist locally. Not an error: yaao_run creates it
    // from base-branch if missing, so a brand-new feature branch is fine.
    const featureBranch = loaded.plan.plan.featureBranch;
    if (featureBranch) {
      const git = ctx.git ?? defaultGit;
      if (await git.isRepo(ctx.cwd)) {
        const exists = await git.branchExists(featureBranch, ctx.cwd);
        if (!exists) {
          extraWarnings.push(
            `plan.featureBranch '${featureBranch}' does not exist locally — yaao_run will create it from base-branch on first run`,
          );
        }
      }
    }
    const allWarnings = [...warns.map((w) => w.message), ...extraWarnings];
    return {
      text: errs.length === 0 ? '✔ plan ok' : `${errs.length} error(s); ${allWarnings.length} warning(s)`,
      structuredContent: {
        ok: errs.length === 0,
        files: [{ path: relPath(ctx.cwd, planAbs), action: 'unchanged' as const }],
        warnings: allWarnings,
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
  /**
   * Override `plan.featureBranch` for this invocation. Empty string clears the
   * field (run with no integration branch). Precedence:
   *   runtime arg > plan.featureBranch > none (merge into baseBranch directly).
   */
  featureBranch?: string;
  /**
   * Override the workspace base-branch for this invocation. Emergency escape
   * hatch (testing a plan against a scratch repo state). Precedence:
   *   runtime arg > workspace config base-branch > "main".
   */
  baseBranch?: string;
}

export async function yaaoRunTool(input: RunToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const planAbs = resolve(cwd, input.plan);
    const loaded = await loadPlan(planAbs, { cwd, config: ctx.config });
    if (input.baseBranch) {
      loaded.plan.config['base-branch'] = input.baseBranch;
    }
    if (input.featureBranch !== undefined) {
      // Empty string clears the field (run trunk-based even when the plan
      // declares a feature branch); any non-empty value overrides it.
      if (input.featureBranch === '') {
        delete loaded.plan.plan.featureBranch;
      } else {
        loaded.plan.plan.featureBranch = input.featureBranch;
      }
    }
    // Pre-flight validation gate — mirrors the CLI `yaao run` behaviour.
    // A plan that names a disabled agent (or violates any other validate-
    // time invariant) gets refused here rather than spawning a backend
    // that will fail at the underlying CLI. The MCP envelope surfaces the
    // errors structurally so the calling agent sees them.
    const { validatePlan } = await import('../plan/validate/index.js');
    const issues = validatePlan(loaded.plan, loaded.source, { cwd, config: ctx.config });
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return {
        text: `${errors.length} error(s); refusing to run`,
        structuredContent: {
          ok: false,
          files: [],
          warnings: issues.filter((i) => i.severity !== 'error').map((w) => w.message),
          errors: errors.map((e) => ({ code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) })),
          status: 'failed' as const,
        },
      };
    }
    const runId = `run-${Date.now().toString(36)}`;
    const result = await runPlan({
      runId,
      plan: loaded.plan,
      planFile: planAbs,
      rootDir: cwd,
      config: ctx.config,
      backendFor: (task) => {
        if (!isAgentEnabled(ctx.config, task.agent)) {
          throw new AgentDisabledError({
            message: `task '${task.id}' targets agent '${task.agent}' which is disabled in yaao.config.json`,
            agent: task.agent,
          });
        }
        return (ctx.backendFor ?? defaultBackendFor)(task.agent);
      },
      ...(input.only || input.skip
        ? { filter: { ...(input.only ? { only: input.only } : {}), ...(input.skip ? { skip: input.skip } : {}) } }
        : {}),
      ...(input.trial !== undefined ? { trial: input.trial } : {}),
      ...(input.noMerge !== undefined ? { noMerge: input.noMerge } : {}),
    });
    const { tasks, unmerged, planCommit, warnings } = await buildRunSummaryPayload(cwd, runId);
    const resolvedBaseBranch = loaded.plan.config['base-branch'];
    const resolvedFeatureBranch = loaded.plan.plan.featureBranch;
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
        resolvedBaseBranch,
        resolvedFeatureBranch: resolvedFeatureBranch ?? null,
        tasks,
        unmerged,
      },
    };
  });
}

interface RunSummaryPayload {
  tasks: unknown[];
  unmerged: { taskId: string; into: string; conflicts: string[] }[];
  planCommit?: string;
  warnings: string[];
}

/**
 * Load the per-run summary and shape it for the MCP response on yaao_run and
 * yaao_resume. Identical envelope on both so callers can swap entry points
 * without retraining their parsers. Failures here fall back to an empty
 * payload — the run already happened; we just couldn't enrich the response.
 */
async function buildRunSummaryPayload(cwd: string, runId: string): Promise<RunSummaryPayload> {
  const journalDir = join(cwd, '.yaao', 'runs');
  const result: RunSummaryPayload = { tasks: [], unmerged: [], warnings: [] };
  try {
    const { summary } = await loadRun(runId, journalDir);
    if (summary.planCommit !== undefined) result.planCommit = summary.planCommit;
    result.tasks = Object.entries(summary.tasks).map(([id, t]) => ({
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
      ...(t.validation !== undefined ? { validation: t.validation } : {}),
    }));
    result.unmerged = Object.entries(summary.tasks)
      .filter(([, t]) => t.mergeStatus === 'merge-failed')
      .map(([id, t]) => ({
        taskId: id,
        into: t.mergeInto ?? '',
        conflicts: t.mergeConflicts ?? [],
      }));
    if (result.unmerged.length > 0) {
      result.warnings.push(
        `${result.unmerged.length} task(s) committed work but failed to merge: ${result.unmerged
          .map((u) => `${u.taskId} → ${u.into}`)
          .join(', ')}`,
      );
    }
  } catch {
    // Journal missing/corrupt — fall back to the bare envelope.
  }
  return result;
}

/** ---- yaao_resume --------------------------------------------------------------- */

export interface ResumeToolInput {
  runId: string;
  /** Re-run anything not in {completed, cached}. Default true. */
  retryFailed?: boolean;
  /** Leave previously-skipped tasks skipped. Default false. */
  reskip?: boolean;
}

/**
 * Continue a prior run under the same runId. Reuses runPlan's existing
 * `resume: true` mode — completed tasks are synthesised as already-done, the
 * scheduler picks up failed / pending / interrupted tasks naturally. The
 * audit trail stays continuous: one runId, one journal, start → fail →
 * resume → success in one timeline.
 *
 * Thin wrapper: this exists so MCP callers don't have to spell out the
 * `resume + filter` recipe themselves and to keep the input vocabulary
 * (`retryFailed`, `reskip`) closer to how users think about the operation.
 */
export async function yaaoResumeTool(input: ResumeToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const journalDir = join(cwd, '.yaao', 'runs');
    // Confirm the run exists and pull its summary so we know the plan file
    // and which tasks were failed / skipped.
    const { summary: prior } = await loadRun(input.runId, journalDir);
    if (!prior.planFile) {
      throw new YaaoError({
        code: 'YAAO_RESUME_NO_PLAN',
        message: `run ${input.runId} has no recorded planFile — cannot resume`,
        hint: 'run might be corrupt or pre-date the planFile recording.',
      });
    }
    const loaded = await loadPlan(prior.planFile, { cwd, config: ctx.config });
    // Pin to the plan-as-committed values: a resume must never silently
    // change merge routing across attempts. The original run's resolved
    // baseBranch + featureBranch live in the journal's `run:start` config
    // block — restore them here, overriding whatever the on-disk plan or
    // workspace config now says.
    if (prior.config?.baseBranch) {
      loaded.plan.config['base-branch'] = prior.config.baseBranch;
    }
    if (prior.config?.featureBranch !== undefined) {
      loaded.plan.plan.featureBranch = prior.config.featureBranch;
    } else {
      // Original run had no feature branch — make sure a freshly-added
      // featureBranch on disk doesn't sneak in on resume.
      delete loaded.plan.plan.featureBranch;
    }
    const retryFailed = input.retryFailed ?? true;
    const reskip = input.reskip ?? false;
    const skipIds: string[] = [];
    if (reskip) {
      for (const [id, t] of Object.entries(prior.tasks)) {
        if (t.status === 'skipped') skipIds.push(id);
      }
    }
    if (!retryFailed) {
      for (const [id, t] of Object.entries(prior.tasks)) {
        if (t.status === 'failed' && !skipIds.includes(id)) skipIds.push(id);
      }
    }
    const result = await runPlan({
      runId: input.runId,
      plan: loaded.plan,
      planFile: prior.planFile,
      rootDir: cwd,
      config: ctx.config,
      backendFor: (task) => {
        if (!isAgentEnabled(ctx.config, task.agent)) {
          throw new AgentDisabledError({
            message: `task '${task.id}' targets agent '${task.agent}' which is disabled in yaao.config.json`,
            agent: task.agent,
          });
        }
        return (ctx.backendFor ?? defaultBackendFor)(task.agent);
      },
      resume: true,
      ...(skipIds.length > 0 ? { filter: { skip: skipIds } } : {}),
    });
    const { tasks, unmerged, planCommit, warnings } = await buildRunSummaryPayload(cwd, input.runId);
    return {
      text: `resumed run ${input.runId} ${result.status} in ${result.durationMs}ms`,
      structuredContent: {
        ok: result.status === 'success',
        files: [],
        warnings,
        errors: [],
        runId: input.runId,
        resumed: true,
        status: result.status,
        durationMs: result.durationMs,
        ...(planCommit !== undefined ? { planCommit } : {}),
        resolvedBaseBranch: loaded.plan.config['base-branch'],
        resolvedFeatureBranch: loaded.plan.plan.featureBranch ?? null,
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

/** ---- yaao_stop ----------------------------------------------------------------- */

export interface StopToolInput {
  runId: string;
}

/**
 * Send SIGTERM to a run's runner process. Lets the agent that started
 * a run via yaao_run stop it again without leaving the MCP session.
 * Same primitive the `yaao stop` CLI command uses.
 *
 * The runner's existing SIGTERM handler stamps `run:end status=cancelled`
 * in the journal before exiting, so a successful stop is observable by
 * every consumer (yaao_inspect, yaao_status, the web workspace).
 *
 * Idempotent on already-finished runs: returns ok=true with
 * reason='no-pid-file' so the caller doesn't have to treat that as a
 * failure.
 */
export async function yaaoStopTool(input: StopToolInput, ctx: ToolContext): Promise<ToolCallResult> {
  return envelope(async () => {
    const cwd = resolve(ctx.cwd);
    const result = signalRun({ cwd, runId: input.runId });
    const ok = result.signaled || result.reason === 'no-pid-file' || result.reason === 'pid-dead';
    const text = result.signaled
      ? `sent SIGTERM to ${input.runId} (pid ${result.pid}); runner will stamp 'cancelled' in the journal and exit`
      : result.reason === 'no-pid-file'
        ? `no runner.pid for ${input.runId} — run is not in flight`
        : result.reason === 'pid-dead'
          ? `runner for ${input.runId} (pid ${result.pid}) is no longer alive`
          : `stop failed: ${result.hint ?? result.reason}`;
    return {
      text,
      structuredContent: {
        ok,
        files: [],
        warnings: ok && !result.signaled ? [`${input.runId} was not running`] : [],
        errors:
          ok || result.reason !== 'kill-failed'
            ? []
            : [{ code: 'YAAO_STOP_FAILED', message: result.hint ?? 'signal failed' }],
        runId: input.runId,
        signaled: result.signaled,
        reason: result.reason,
        ...(result.pid !== undefined ? { pid: result.pid } : {}),
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
        const fb = safePeekFeatureBranch(execAbs);
        row['featureBranch'] = fb ?? null;
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

    const skipped: PruneSkip[] = [];
    const errors: { code: string; message: string; hint?: string }[] = [];

    const wtManager = new WorktreeManager({ git, rootDir: cwd, worktreeRoot });
    const knownWorktrees = await wtManager.list();
    // Index worktrees both by their sourceRunId AND by branch — a worktree
    // stamped by run A may hold a branch that belongs to a task in run B
    // (cache-key reuse, F12.6-era). When pruning run B, the branch delete
    // would otherwise fail with "branch used by worktree" because we'd only
    // looked for worktrees whose sourceRunId == B. Indexing by branch closes
    // that hole.
    const worktreesByRunId = new Map<string, typeof knownWorktrees>();
    const worktreesByBranch = new Map<string, typeof knownWorktrees[number]>();
    for (const w of knownWorktrees) {
      if (w.sourceRunId) {
        const arr = worktreesByRunId.get(w.sourceRunId) ?? [];
        arr.push(w);
        worktreesByRunId.set(w.sourceRunId, arr);
      }
      if (w.branch) worktreesByBranch.set(w.branch, w);
    }

    // -------- Phase 1: plan -----------------------------------------------
    // Compute everything we'd remove from the current snapshot, independent
    // of dryRun. The actual-mutation pass below acts only on this plan, so
    // dry-run output and actual output describe the same decisions over the
    // same state. (Previously, dirty checks could race against partial
    // mutations from earlier in the same loop; now they're all taken from
    // the snapshot up front.)
    interface PlannedWorktree { path: string; taskId: string }
    interface PlannedBranch { branch: string; taskId: string }
    const plannedWorktrees: PlannedWorktree[] = [];
    const plannedBranches: PlannedBranch[] = [];
    const plannedRunDirs: string[] = [];
    const sawWorktreePath = new Set<string>();
    const sawBranch = new Set<string>();

    // Per-target tally of whether any artifact got skipped by a safety
    // check. When true, we keep the run dir around so a follow-up
    // `yaao_prune({target: 'run', runId})` can still find the run and the
    // user can re-attempt cleanup after deciding how to handle the skipped
    // item. Previously the run dir was deleted unconditionally, which
    // orphaned skipped branches: they survived the prune but had no run-dir
    // anchor, so subsequent prune calls returned YAAO_PRUNE_NO_MATCH.
    const targetHadSkip = new Map<string, boolean>();

    for (const target of targets) {
      if (scope.includes('worktrees')) {
        // Worktrees stamped by this run...
        const wtsForRun = worktreesByRunId.get(target.runId) ?? [];
        // ...plus any worktree (stamped by any run) that holds a branch
        // this run's tasks own. Without this, cross-run branch holders
        // survive the worktree pass and block the branch pass.
        const branchesOfTarget = new Set(
          Object.values(target.tasks)
            .map((t) => t.branch)
            .filter((b): b is string => Boolean(b)),
        );
        const wtsByBranch = [...branchesOfTarget]
          .map((b) => worktreesByBranch.get(b))
          .filter((w): w is NonNullable<typeof w> => Boolean(w));
        const candidates = [...wtsForRun, ...wtsByBranch];
        for (const w of candidates) {
          if (sawWorktreePath.has(w.path)) continue;
          sawWorktreePath.add(w.path);
          // Refuse to remove a worktree with uncommitted changes unless force.
          // Compute once, against the up-front snapshot, so dry-run and
          // actual-run see the same answer.
          //
          // Filters out anything under `.yaao/` — yaao's own bookkeeping
          // (notably the `.yaao/.task` stamp WorktreeManager writes) is
          // always "untracked" from git's perspective, which would flag
          // every worktree as dirty and bypass cleanup. The lifecycle's
          // empty-work guard does the same filter for the same reason.
          let dirty = false;
          try {
            // eslint-disable-next-line no-await-in-loop -- per-worktree check
            const s = await git.status(w.path);
            const realUntracked = s.untracked.filter((p) => !p.startsWith('.yaao/'));
            const realFiles = s.files.filter((f) => !f.path.startsWith('.yaao/'));
            const realRenamed = s.renamed.filter((f) => !f.path.startsWith('.yaao/'));
            dirty = realFiles.length > 0 || realUntracked.length > 0 || realRenamed.length > 0;
          } catch {
            // Worktree may already be gone; treat as not-dirty so the
            // subsequent removal pass can clean up any straggler state.
          }
          if (dirty && !force) {
            skipped.push({
              kind: 'worktree',
              path: w.path,
              reason: 'uncommitted-changes',
            });
            targetHadSkip.set(target.runId, true);
            continue;
          }
          plannedWorktrees.push({ path: w.path, taskId: w.taskId });
        }
      }
      if (scope.includes('branches')) {
        for (const [taskId, t] of Object.entries(target.tasks)) {
          const branch = t.branch;
          if (!branch || sawBranch.has(branch)) continue;
          sawBranch.add(branch);
          if (branch === baseBranch) {
            // Hard rule: never delete the configured base-branch, no matter
            // what the journal claims a task ran on.
            skipped.push({
              kind: 'branch',
              path: branch,
              reason: `is-base-branch (refusing to delete ${baseBranch})`,
            });
            targetHadSkip.set(target.runId, true);
            continue;
          }
          // Decide whether the branch is safe to delete. The journal says
          // "merged" when an explicit merge step succeeded — but a branch
          // can also be safe when it has no unique commits relative to
          // base. The most common case for the latter: a task failed before
          // committing anything, so its branch literally points at base's
          // tip. Forcing the user to pass `force: true` to clean those up
          // is friction without safety benefit.
          let safeToDelete = t.mergeStatus === 'merged';
          if (!safeToDelete) {
            try {
              // eslint-disable-next-line no-await-in-loop -- per-branch
              safeToDelete = await git.isAncestor(branch, baseBranch, cwd);
            } catch {
              // Bad ref / git error: stay on the safe side.
            }
          }
          if (!force && !safeToDelete) {
            skipped.push({
              kind: 'branch',
              path: branch,
              reason: t.mergeStatus === 'merge-failed' ? 'unmerged-commits' : 'never-merged',
            });
            targetHadSkip.set(target.runId, true);
            continue;
          }
          plannedBranches.push({ branch, taskId });
        }
      }
      if (scope.includes('runs')) {
        // Defer the run-dir delete when any in-scope artifact for this run
        // was held back by a safety check. Removing the run dir under
        // those conditions strands the skipped artifact: subsequent prune
        // calls can't reach it via `target: run` because the journal that
        // listed the run is gone.
        if (targetHadSkip.get(target.runId)) {
          skipped.push({
            kind: 'runDir',
            path: join(journalDir, target.runId),
            reason: 'run-has-skipped-artifacts (re-run prune with force: true to finish cleanup)',
          });
        } else {
          plannedRunDirs.push(join(journalDir, target.runId));
        }
      }
    }

    const removed: PruneRemoved = {
      worktrees: plannedWorktrees.map((w) => w.path),
      branches: plannedBranches.map((b) => b.branch),
      runDirs: plannedRunDirs.slice(),
    };
    if (dryRun) return pruneResult(dryRun, removed, skipped, errors);

    // -------- Phase 2: apply, in the only safe order ----------------------
    // Worktrees BEFORE branches: `git branch -D` refuses to delete a branch
    // currently checked out by any worktree. The previous per-target loop
    // covered this within a single target but missed cross-run branch
    // holders; collecting both up front and removing every worktree before
    // any branch fixes it.
    // Branches BEFORE run dirs: nothing technically depends on the order
    // here, but the original code did runs after branches, so preserve that.
    removed.worktrees = [];
    removed.branches = [];
    removed.runDirs = [];
    for (const w of plannedWorktrees) {
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
    for (const b of plannedBranches) {
      try {
        await git.deleteBranch(b.branch, { force: true }, cwd);
        removed.branches.push(b.branch);
      } catch (e) {
        errors.push({
          code: 'YAAO_PRUNE_BRANCH',
          message: `failed to delete branch ${b.branch} (task ${b.taskId}): ${(e as Error).message}`,
        });
      }
    }
    for (const runPath of plannedRunDirs) {
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

    // Reap empty per-run worktree parent dirs (.yaao/worktrees/<runId>/).
    // Removing task subdirs leaves these behind otherwise — every prune
    // accumulates a little graveyard.
    const wtRoot = resolve(cwd, worktreeRoot);
    const reapedParents = new Set<string>();
    for (const w of plannedWorktrees) {
      const parent = dirname(w.path);
      if (reapedParents.has(parent)) continue;
      reapedParents.add(parent);
      // Only touch dirs strictly under the configured worktree root.
      if (!parent.startsWith(`${wtRoot}/`) && parent !== wtRoot) continue;
      if (parent === wtRoot) continue;
      try {
        const remaining = readdirSync(parent);
        if (remaining.length === 0) rmdirSync(parent);
      } catch {
        // Parent may already be gone, or non-empty (another run's
        // worktrees still there) — both are fine, leave it.
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

/**
 * Cheap peek at `plan.featureBranch` in an execution YAML — used by
 * yaao_inspect to render the per-plan integration branch without paying for a
 * full plan load + schema validation. Returns undefined if the file is
 * missing, unparseable, or doesn't declare the field.
 */
function safePeekFeatureBranch(p: string): string | undefined {
  try {
    const doc = parseYaml(readFileSync(p, 'utf8')) as { plan?: { featureBranch?: unknown } } | undefined;
    const fb = doc?.plan?.featureBranch;
    return typeof fb === 'string' && fb.length > 0 ? fb : undefined;
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
