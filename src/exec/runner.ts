import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { YaaoConfig } from '../config/types.js';
import { Scheduler, type SchedulerEvent } from './scheduler.js';
import { Lifecycle } from './lifecycle.js';
import { createRunBus, type RunBus, type RunEvent } from './bus.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { planBranches } from '../git/branch-graph.js';
import { git as defaultGit, type Git } from '../git/git.js';
import { openJournal, hashPlan, loadRun, type RunJournal } from '../git/journal.js';
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

  if (opts.onProgress) {
    bus.subscribe(opts.onProgress);
  }

  const journal: RunJournal = await openJournal(opts.runId, { dir: journalDir });
  const planContents = readFileSync(opts.planFile, 'utf8');
  await journal.append({
    t: 'run:start',
    time: new Date().toISOString(),
    runId: opts.runId,
    planFile: opts.planFile,
    planHash: hashPlan(planContents),
    config: {
      baseBranch: opts.plan.config['base-branch'],
      maxParallel: opts.trial ? 1 : opts.plan.config['max-parallel'],
    },
  });
  bus.emit({ type: 'run:start', runId: opts.runId, planFile: opts.planFile });

  const scheduler = new Scheduler({
    plan: opts.plan,
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    maxParallel: opts.trial ? 1 : opts.plan.config['max-parallel'],
    onEvent: (ev) => bus.emit(ev),
  });
  // Stream scheduler events into the journal for resume.
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
    }
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
    ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.ctxSysDirective !== undefined ? { ctxSysDirective: opts.ctxSysDirective } : {}),
  });

  const taskById = new Map(opts.plan.tasks.map((t) => [t.id, t]));

  // Resume: mark previously-completed tasks as done and stash failure context
  // for tasks that need re-running. Done after lifecycle construction so the
  // scheduler is fully wired before we synthesize events into it.
  const priorFailures = new Map<string, PriorFailureContext>();
  if (opts.resume) {
    try {
      const { summary: priorSummary } = await loadRun(opts.runId, journalDir);
      for (const [id, task] of Object.entries(priorSummary.tasks)) {
        if (!taskById.has(id)) continue;
        if (task.status === 'completed') {
          // Synthesize completion so downstream tasks unblock without re-running.
          scheduler.startTask(id);
          scheduler.completeTask(id, {
            ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
          });
        } else if (task.status === 'failed') {
          priorFailures.set(id, {
            attempt: task.attempts ?? 1,
            errorMessage: task.error?.message ?? 'previous attempt failed',
            ...(task.validation !== undefined ? { validation: task.validation } : {}),
          });
        }
      }
    } catch {
      // No prior journal — proceed as a fresh run, ignoring the resume flag.
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
  return { status, durationMs, bus };
}

/** Tiny helper so callers can construct YaaoErrors without importing them everywhere. */
export function liftError(err: unknown): YaaoError {
  if (err instanceof YaaoError) return err;
  return new YaaoError({ code: 'YAAO_RUN', message: (err as Error)?.message ?? String(err), cause: err });
}
