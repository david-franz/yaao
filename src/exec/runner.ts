import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import { resolveBranchPolicy } from '../plan/schema/types.js';
import type { YaaoConfig } from '../config/types.js';
import { Scheduler, type SchedulerEvent } from './scheduler.js';
import { Lifecycle } from './lifecycle.js';
import { createRunBus, type RunBus, type RunEvent } from './bus.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { planBranches } from '../git/branch-graph.js';
import { git as defaultGit, type Git } from '../git/git.js';
import { openJournal, hashPlan, loadRun, type RunJournal, type RunSummary } from '../git/journal.js';
import type { PriorFailureContext } from './lifecycle.js';
import type { AgentBackend, McpServerConfig } from '../agents/backend.js';
import { YaaoError, AgentUnavailableError } from '../log/errors.js';

export interface RunOptions {
  runId: string;
  plan: ResolvedPlan;
  planFile: string;
  rootDir: string;
  config: YaaoConfig;
  backendFor: (task: ResolvedTask) => AgentBackend;
  filter?: { only?: string[]; skip?: string[] };
  /** Default false. Trial: max-parallel 1 + no merge. */
  trial?: boolean;
  /** Used to override the default git wrapper in tests. */
  git?: Git;
  /** Override the default journal location. */
  journalDir?: string;
  /** Override the per-run dir for context.md artifacts. */
  runDir?: string;
  /** Pre-built MCP server list to pass to every spawn (F7.2). */
  mcpServers?: McpServerConfig[];
  /** System-prompt directive injected into every task when ctx-sys is enabled (F7.3). */
  ctxSysDirective?: string;
  /** Live progress callback. Receives every event from the run bus so the CLI
   * can render task transitions and agent activity to stderr. */
  onProgress?: (ev: RunEvent) => void;
  /** When true, look up the prior summary for `runId` and treat completed
   * tasks as already-done, retrying failed tasks with their captured context. */
  resume?: boolean;
  /**
   * Per-invocation override of `config.run.require-tracked-plan`. Used by the
   * CLI `--allow-untracked-plan` flag (which downgrades to 'warn').
   */
  requireTrackedPlan?: 'error' | 'warn' | 'off';
  /**
   * When true, auto-commit the plan file to the base-branch (or current
   * branch when checked out at rootDir) before the run starts, so every run
   * is anchored to a recorded plan. Subject mirrors the post-run commit
   * style: `[yaao] plan <name> (<runId>)`. Wired by the CLI `--commit-plan`
   * flag.
   */
  commitPlan?: boolean;
  /**
   * When true, skip the lifecycle's auto-merge step. Tasks still complete on
   * their own branches; the user lands them manually (or via `gh pr create`).
   * This is the "preview" / "PR-only" mode that addresses the
   * big-blast-radius default — see CLI `--no-merge`.
   */
  noMerge?: boolean;
}

export interface RunResult {
  status: 'success' | 'failed' | 'cancelled';
  durationMs: number;
  bus: RunBus;
}

export async function runPlan(opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const bus = createRunBus();
  const git: Git = opts.git ?? defaultGit;
  const branchPlan = planBranches(opts.plan);
  const journalDir = opts.journalDir ?? join(opts.rootDir, '.yaao', 'runs');
  const runDir = opts.runDir ?? join(journalDir, opts.runId);
  mkdirSync(runDir, { recursive: true });

  // Drop our pid into the run dir so out-of-process callers (the CLI's
  // `yaao stop`, the MCP `yaao_stop` tool, the web Cancel button) can
  // locate this runner and send it SIGTERM. The existing signal handler
  // (5a05f8c) takes care of stamping `run:end status=cancelled` and
  // exiting cleanly. Best-effort cleanup on graceful exit below.
  const pidPath = join(runDir, 'runner.pid');
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
  } catch {
    // Don't fail the run if we can't write the pid file — the run is
    // still observable + resumable, just not externally cancellable.
  }

  if (opts.onProgress) {
    bus.subscribe(opts.onProgress);
  }

  // Plan-tracking gate: refuse-or-warn when the plan file isn't recorded in
  // git, so a run can't merge work whose source-of-truth plan is sitting
  // untracked. Anchors the run to a commit/blob SHA when it _is_ tracked.
  const planState = await resolvePlanState({
    git,
    rootDir: opts.rootDir,
    planFile: opts.planFile,
    requireMode: opts.requireTrackedPlan ?? opts.config.run['require-tracked-plan'],
    commitPlan: opts.commitPlan ?? false,
    bus,
    onCommitPlan: async (relPath, message) => {
      await git.add([relPath], opts.rootDir);
      return git.commit(message, undefined, opts.rootDir);
    },
    runId: opts.runId,
    planName: opts.plan.plan.name,
  });

  // Resolve branch policy once and use it everywhere downstream — pre-creating
  // featureBranch, recording it in the journal, and (via lifecycle) routing
  // auto-merges to it.
  const policy = resolveBranchPolicy(opts.plan);

  // F14.9 — Validate base-branch exists before any worktree creation runs.
  // Without this, a repo whose default branch is 'master' (and a plan
  // pinned to 'main' from yaao init's pre-F14.9 days) fails at
  // worktree-manager.create's `git rev-parse --verify` with a cryptic
  // GitError. Catching it here gives the user a clear hint pointing at
  // both the config field and the runtime override flag.
  if (await git.isRepo(opts.rootDir)) {
    const baseExists = await git.branchExists(policy.baseBranch, opts.rootDir);
    if (!baseExists) {
      throw new YaaoError({
        code: 'YAAO_BASE_BRANCH_MISSING',
        message: `base-branch '${policy.baseBranch}' not found in this repo`,
      });
    }
  }

  if (policy.featureBranch && (await git.isRepo(opts.rootDir))) {
    const exists = await git.branchExists(policy.featureBranch, opts.rootDir);
    if (!exists) {
      try {
        await git.createBranch(policy.featureBranch, policy.baseBranch, opts.rootDir);
      } catch (e) {
        throw new YaaoError({
          code: 'YAAO_FEATURE_BRANCH_CREATE',
          message: `failed to create featureBranch '${policy.featureBranch}' from '${policy.baseBranch}': ${(e as Error).message}`,
          hint: `make sure '${policy.baseBranch}' exists locally, or create '${policy.featureBranch}' yourself before running.`,
          cause: e,
        });
      }
    }
  }

  const journal: RunJournal = await openJournal(opts.runId, { dir: journalDir });
  const planContents = readFileSync(opts.planFile, 'utf8');
  await journal.append({
    t: 'run:start',
    time: new Date().toISOString(),
    runId: opts.runId,
    planFile: opts.planFile,
    planHash: hashPlan(planContents),
    ...(planState.commit !== undefined ? { planCommit: planState.commit } : {}),
    ...(planState.blob !== undefined ? { planBlob: planState.blob } : {}),
    config: {
      baseBranch: policy.baseBranch,
      maxParallel: opts.trial ? 1 : opts.plan.config['max-parallel'],
      ...(policy.featureBranch !== undefined ? { featureBranch: policy.featureBranch } : {}),
    },
  });
  bus.emit({ type: 'run:start', runId: opts.runId, planFile: opts.planFile });

  // Stream scheduler events into the journal for resume. The subscribe
  // call MUST happen before `new Scheduler(...)` below — the scheduler's
  // constructor synchronously emits task:queued (and task:ready, via
  // refreshReady) for every task via bus.emit. Subscribing after
  // construction silently drops those events on the floor, leaving the
  // journal without task:queued lines and the web viewer without the
  // dependency structure it needs to render the live DAG.
  const recordSchedulerEvent = (ev: SchedulerEvent): void => {
    if (ev.type === 'task:queued') {
      void journal.append({
        t: 'task:queued',
        time: new Date().toISOString(),
        taskId: ev.taskId,
        depends: ev.depends,
      });
    } else if (ev.type === 'task:ready') {
      void journal.append({ t: 'task:ready', time: new Date().toISOString(), taskId: ev.taskId });
    } else if (ev.type === 'task:skipped') {
      void journal.append({
        t: 'task:skipped',
        time: new Date().toISOString(),
        taskId: ev.taskId,
        reason: ev.reason,
      });
    }
  };
  bus.subscribe((ev) => {
    if (ev.type.startsWith('task:queued') || ev.type === 'task:ready' || ev.type === 'task:skipped') {
      recordSchedulerEvent(ev as SchedulerEvent);
    } else if (ev.type === 'task:merged') {
      // Persist outgoing-merge outcomes so `yaao status` and downstream
      // tooling can see which tasks landed on base and which are still
      // stranded on their own branches.
      void journal.append({
        t: 'task:merged',
        time: new Date().toISOString(),
        taskId: ev.taskId,
        into: ev.into,
        mergeCommit: ev.mergeCommit,
      });
    } else if (ev.type === 'task:merge-failed') {
      void journal.append({
        t: 'task:merge-failed',
        time: new Date().toISOString(),
        taskId: ev.taskId,
        into: ev.into,
        reason: ev.reason,
        conflicts: ev.conflicts,
      });
    } else if (ev.type === 'task:agent-event') {
      // Forward agent activity to the journal so cross-process consumers
      // (the web viewer's SSE stream) can render the live agent thoughts,
      // tool-use, and stdout/stderr. Previously these only fired on the
      // in-process bus, so `yaao web` showed lifecycle transitions but
      // nothing between task:running and task:completed.
      void journal.append({
        t: 'task:agent-event',
        time: new Date().toISOString(),
        taskId: ev.taskId,
        ev: ev.ev,
      });
    }
  });

  // Constructed AFTER the journal subscriber above is wired. The scheduler
  // synchronously emits task:queued (and task:ready, via refreshReady)
  // for every task during construction; doing the subscribe first means
  // the journal captures those events instead of dropping them.
  const scheduler = new Scheduler({
    plan: opts.plan,
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    maxParallel: opts.trial ? 1 : opts.plan.config['max-parallel'],
    onEvent: (ev) => bus.emit(ev),
  });

  const worktreeManager = new WorktreeManager({
    git,
    rootDir: opts.rootDir,
    worktreeRoot: opts.plan.config['worktree-root'],
  });

  // Pre-flight: every task's backend must be available.
  for (const task of opts.plan.tasks) {
    const backend = opts.backendFor(task);
    // eslint-disable-next-line no-await-in-loop -- pre-flight must be sequential to short-circuit
    const avail = await backend.isAvailable();
    if (!avail.available) {
      const err = new AgentUnavailableError({
        message: `agent '${backend.name}' required by task '${task.id}' is unavailable: ${avail.reason ?? 'unknown'}`,
        agent: backend.name,
      });
      bus.emit({ type: 'run:end', runId: opts.runId, status: 'failed' });
      await journal.append({
        t: 'run:end',
        time: new Date().toISOString(),
        status: 'failed',
        durationMs: Date.now() - start,
      });
      await journal.close();
      bus.close();
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  const lifecycle = new Lifecycle({
    runId: opts.runId,
    plan: opts.plan,
    scheduler,
    worktreeManager,
    branchPlan,
    bus,
    journal,
    git,
    rootDir: opts.rootDir,
    backendFor: opts.backendFor,
    runDir,
    promptRefBaseDir: resolvePath(opts.rootDir),
    noMerge: opts.noMerge ?? false,
    ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.ctxSysDirective !== undefined ? { ctxSysDirective: opts.ctxSysDirective } : {}),
  });

  const taskById = new Map(opts.plan.tasks.map((t) => [t.id, t]));

  // Resume: mark previously-completed tasks as done, stash failure context
  // for tasks that need re-running with context, and let interrupted (still
  // "running" in the prior journal) tasks fall through to be re-launched on
  // the existing worktree. Done after lifecycle construction so the scheduler
  // is fully wired before we synthesize events into it.
  const priorFailures = new Map<string, PriorFailureContext>();
  if (opts.resume) {
    let priorSummary: RunSummary | undefined;
    try {
      priorSummary = (await loadRun(opts.runId, journalDir)).summary;
    } catch {
      // No prior journal — proceed as a fresh run, ignoring the resume flag.
    }
    if (priorSummary) {
      // Synthesising a completion requires the scheduler to consider the task
      // 'ready', which requires its deps to be completed first. priorSummary's
      // iteration order isn't guaranteed to be topological (it's the order
      // events first appeared in the journal, which gets scrambled by cascade
      // skips across runs). So collect the work first, then drain it in
      // multiple passes — synthesise whatever's currently ready, let the
      // cascade unblock downstream tasks, repeat until nothing more is ready.
      const toSynth = new Map<string, { durationMs?: number }>();
      for (const [id, task] of Object.entries(priorSummary.tasks)) {
        if (!taskById.has(id)) continue;
        if (task.status === 'completed') {
          toSynth.set(id, task.durationMs !== undefined ? { durationMs: task.durationMs } : {});
        } else if (task.status === 'failed') {
          priorFailures.set(id, {
            attempt: task.attempts ?? 1,
            errorMessage: task.error?.message ?? 'previous attempt failed',
            ...(task.validation !== undefined ? { validation: task.validation } : {}),
          });
        }
        // 'running' or 'pending' tasks (interrupted mid-run) fall through —
        // the scheduler picks them up in its normal flow, and the lifecycle's
        // idempotent worktree-get-or-create reuses the existing worktree.
      }
      let progressed = true;
      while (progressed && toSynth.size > 0) {
        progressed = false;
        const snap = scheduler.snapshot();
        for (const id of [...toSynth.keys()]) {
          if (snap[id] !== 'ready') continue;
          const outcome = toSynth.get(id) ?? {};
          scheduler.startTask(id);
          scheduler.completeTask(id, outcome);
          // Persist the synthesised completion so a subsequent resume sees
          // it in the journal (sticky-completion replay then preserves it).
          // eslint-disable-next-line no-await-in-loop -- sequential resume bootstrap
          await journal.append({
            t: 'task:completed',
            time: new Date().toISOString(),
            taskId: id,
            durationMs: outcome.durationMs ?? 0,
            filesChanged: 0,
            commit: '',
          });
          toSynth.delete(id);
          progressed = true;
        }
      }
      // Anything still in toSynth couldn't be made ready (its deps weren't
      // completed in the prior summary either). Leave them; the scheduler
      // will pick them up if/when their deps finish in this run.
    }
  }

  const inFlight: Promise<void>[] = [];
  while (!scheduler.done()) {
    const ready = scheduler.readyTasks();
    if (ready.length === 0 && inFlight.length === 0) {
      // Nothing ready and nothing running — done unless retries are queued, but
      // scheduler.done() handles that case. This break is a safety net.
      break;
    }
    for (const id of ready) {
      const task = taskById.get(id);
      if (!task) continue;
      scheduler.startTask(id);
      const priorFailure = priorFailures.get(id);
      const promise = lifecycle
        .runTask(task, priorFailure ? { priorFailure } : {})
        .finally(() => {
        const idx = inFlight.indexOf(promise);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(promise);
    }
    if (inFlight.length > 0) {
      // eslint-disable-next-line no-await-in-loop -- we must wait for at least one to finish
      await Promise.race(inFlight);
    }
  }

  const anyFailed = Object.values(scheduler.snapshot()).some((s) => s === 'failed');
  const status: RunResult['status'] = anyFailed ? 'failed' : 'success';
  const durationMs = Date.now() - start;
  bus.emit({ type: 'run:end', runId: opts.runId, status });
  await journal.append({
    t: 'run:end',
    time: new Date().toISOString(),
    status,
    durationMs,
  });
  await journal.close();
  bus.close();
  // Best-effort cleanup of our pid file on graceful exit. The signal-exit
  // path doesn't unlink — the file lingering after a kill is harmless
  // (signalRun's kill(pid, 0) alive-check handles stale pid files).
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore — file may already be gone, or never existed
  }
  return { status, durationMs, bus };
}

/** Tiny helper so callers can construct YaaoErrors without importing them everywhere. */
export function liftError(err: unknown): YaaoError {
  if (err instanceof YaaoError) return err;
  return new YaaoError({ code: 'YAAO_RUN', message: (err as Error)?.message ?? String(err), cause: err });
}

interface ResolvePlanStateOptions {
  git: Git;
  rootDir: string;
  planFile: string;
  requireMode: 'error' | 'warn' | 'off';
  commitPlan: boolean;
  bus: RunBus;
  onCommitPlan: (relPath: string, message: string) => Promise<string>;
  runId: string;
  planName: string;
}

interface PlanStateOutcome {
  commit?: string;
  blob?: string;
}

/**
 * Implements the plan-tracking gate. Returns the planCommit/planBlob to record
 * in the journal; throws YAAO_PLAN_UNTRACKED when the run must refuse to start.
 */
async function resolvePlanState(opts: ResolvePlanStateOptions): Promise<PlanStateOutcome> {
  if (opts.requireMode === 'off' && !opts.commitPlan) return {};
  if (!(await opts.git.isRepo(opts.rootDir))) {
    // Outside a git repo, the gate is meaningless. Skip silently — the user
    // ran `yaao run` without source control and that's their call.
    return {};
  }
  const rel = relative(opts.rootDir, opts.planFile) || opts.planFile;
  const state = await opts.git.planFileState(rel, opts.rootDir);
  const isClean = state.tracked && !state.dirty;
  if (isClean) {
    const out: PlanStateOutcome = {};
    if (state.headSha) out.commit = state.headSha;
    if (state.blobSha) out.blob = state.blobSha;
    return out;
  }
  if (opts.commitPlan) {
    // Auto-commit path: pre-run "[yaao] plan <name> (<runId>)" so the run is
    // anchored to a commit even when the user hadn't checked the plan in yet.
    const msg = `[yaao] plan ${opts.planName} (${opts.runId})`;
    try {
      const sha = await opts.onCommitPlan(rel, msg);
      // Re-read state so callers get the now-committed blob SHA.
      const after = await opts.git.planFileState(rel, opts.rootDir);
      const out: PlanStateOutcome = { commit: sha };
      if (after.blobSha) out.blob = after.blobSha;
      return out;
    } catch (e) {
      throw new YaaoError({
        code: 'YAAO_PLAN_COMMIT_FAILED',
        message: `--commit-plan: failed to commit ${rel}: ${(e as Error).message}`,
        hint: 'Stage the plan file yourself with `git add` + `git commit`, then rerun without --commit-plan.',
        cause: e,
      });
    }
  }
  if (opts.requireMode === 'warn') {
    opts.bus.emit({
      type: 'run:warning',
      runId: opts.runId,
      message: state.tracked
        ? `plan file ${rel} has uncommitted changes — the run will not be anchored to a recorded plan`
        : `plan file ${rel} is not tracked in git — the run will not be anchored to a recorded plan`,
    });
    return {};
  }
  // requireMode === 'error' and we don't have a clean tracked plan.
  throw new YaaoError({
    code: 'YAAO_PLAN_UNTRACKED',
    message: state.tracked
      ? `plan file ${rel} has uncommitted changes; refusing to start a run from an unrecorded plan`
      : `plan file ${rel} is not tracked in git; refusing to start a run from an unrecorded plan`,
    hint: 'Commit the plan file (`git add <plan> && git commit`), pass `--commit-plan` to let yaao do it, or pass `--allow-untracked-plan` to downgrade to a warning.',
  });
}
