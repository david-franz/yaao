import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface SerializedConfigSubset {
  baseBranch: string;
  maxParallel: number;
  /** Resolved per-plan integration branch. Absent → tasks merged directly
   * into baseBranch. Captured so a resumed run can be audited against the
   * same merge routing it started with. */
  featureBranch?: string;
}

export type JournalEvent =
  | {
      t: 'run:start';
      time: string;
      runId: string;
      planFile: string;
      planHash: string;
      /** HEAD commit at run-start when the plan file was tracked. Anchors the
       * run to a real point in history so "where did this commit come from?"
       * can be answered from git alone. Omitted when the run started against
       * an untracked plan (config: run.require-tracked-plan != 'error'). */
      planCommit?: string;
      /** Blob SHA of the plan file in HEAD at run-start. Combined with
       * planCommit gives a precise content-anchor independent of any
       * post-run history rewrites. */
      planBlob?: string;
      config: SerializedConfigSubset;
    }
  | { t: 'task:queued'; time: string; taskId: string; depends: string[] }
  | { t: 'task:ready'; time: string; taskId: string }
  | {
      t: 'task:running';
      time: string;
      taskId: string;
      agent: string;
      model?: string;
      worktree: string;
      branch: string;
      pid: number;
      /**
       * Non-empty when the worktree being entered was originally stamped by a
       * different run (resume, or fall-through from a prior failed run). Lets
       * `yaao status` and the MCP run-summary surface a `cached: true` signal
       * with a pointer to the original run instead of users guessing why the
       * worktree path doesn't match the current runId.
       */
      cachedFromRunId?: string;
    }
  | { t: 'task:output'; time: string; taskId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | {
      /** Agent activity: stdout/stderr chunks, thinking blocks, tool-use
       * envelopes. Forwarded from the run bus so the web viewer (which is a
       * journal-tail consumer) can render the live agent stream — without
       * this, the journal only carries lifecycle transitions and the web's
       * activity panel shows nothing between task:running and task:completed.
       * Can balloon journal size on long thinking traces; size is the cost
       * of paid for live visibility. */
      t: 'task:agent-event';
      time: string;
      taskId: string;
      ev: { type: 'stdout' | 'stderr' | 'tool-use' | 'thinking'; data: string; timestamp: string };
    }
  | {
      t: 'task:completed';
      time: string;
      taskId: string;
      durationMs: number;
      filesChanged: number;
      commit: string;
      /** Agent that produced the completion. Lets the summary show who actually
       * did the work even when a later (failed) attempt was run with a
       * different agent — the sticky-completion replay then preserves both
       * status and the completing agent. */
      agent?: string;
      /**
       * Proof of the validation verdict. When present, the task had a
       * validation command and yaao decided pass/fail based strictly on
       * `decisionReason`. Recorded on every completion (including success)
       * so the run summary can answer "why did yaao consider this passed?"
       * without a second source of truth.
       */
      validation?: {
        command: string;
        exitCode: number;
        durationMs: number;
        decisionReason: 'exit-code';
        mustPass: boolean;
      };
    }
  | {
      t: 'task:failed';
      time: string;
      taskId: string;
      durationMs: number;
      error: { code: string; message: string };
      /** Captured tails from the failing command, when available. Useful for
       * post-mortem inspection and for `--resume` to feed back into the agent. */
      validation?: { command: string; stdoutTail?: string; stderrTail?: string };
    }
  | {
      t: 'task:retry-attempt';
      time: string;
      taskId: string;
      attempt: number;
      error: { code: string; message: string };
      validation?: { command: string; stdoutTail?: string; stderrTail?: string };
    }
  | { t: 'task:skipped'; time: string; taskId: string; reason: 'depFailed' | 'filtered' }
  | { t: 'task:merged'; time: string; taskId: string; into: string; mergeCommit: string }
  | {
      t: 'task:merge-failed';
      time: string;
      taskId: string;
      into: string;
      reason: string;
      conflicts: string[];
    }
  | { t: 'merge:start'; time: string; taskId: string; into: string }
  | { t: 'merge:conflict'; time: string; taskId: string; files: string[] }
  | { t: 'merge:resolved'; time: string; taskId: string; by: 'auto' | 'agent' | 'manual'; commit: string }
  | { t: 'run:end'; time: string; status: 'success' | 'failed' | 'cancelled'; durationMs: number };

export interface RunSummary {
  runId: string;
  planFile: string;
  planHash: string;
  /** Commit at run-start; present when the plan file was tracked. */
  planCommit?: string;
  /** Blob SHA of the plan file at run-start. */
  planBlob?: string;
  /** Resolved baseBranch + featureBranch the run started with. */
  config?: SerializedConfigSubset;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  tasks: Record<
    string,
    {
      status: TaskStatus;
      agent?: string;
      branch?: string;
      worktree?: string;
      durationMs?: number;
      error?: { code: string; message: string };
      /**
       * Validation outcome the task's pass/fail was decided on. `exitCode`
       * and `decisionReason` are populated by `task:completed`; `stdoutTail`
       * / `stderrTail` are populated by `task:failed` / `task:retry-attempt`
       * so `--resume` can seed the next attempt's prompt with the prior
       * failure context.
       */
      validation?: {
        command: string;
        exitCode?: number;
        durationMs?: number;
        decisionReason?: 'exit-code';
        mustPass?: boolean;
        stdoutTail?: string;
        stderrTail?: string;
      };
      /** Attempts consumed by this task, including retries. */
      attempts?: number;
      /** When skipped, why: cascade from a failed dep, or filtered out via
       * --only / --skip. Lets the status table distinguish "blocked" tasks
       * from user-requested skips. */
      skipReason?: 'depFailed' | 'filtered';
      /** Outcome of the outgoing auto-merge / merge.into step. `merged`
       * means the task's branch landed on its target (typically base-branch
       * when merge.strategy=auto). `merge-failed` means a conflict aborted
       * the merge — the task itself succeeded, but the work is still only
       * on its own branch and the user needs to land it manually. */
      mergeStatus?: 'merged' | 'merge-failed';
      mergeInto?: string;
      mergeCommit?: string;
      mergeConflicts?: string[];
      mergeReason?: string;
      /**
       * Number of files the task's commit touched. Lets callers report a real
       * diff size without a follow-up `git log` / `git diff`.
       */
      filesChanged?: number;
      /** Commit SHA produced by the task (or '' when no commit was created). */
      commit?: string;
      /** Original runId when this run reused a worktree stamped by an earlier run. */
      cachedFromRunId?: string;
    }
  >;
}

export interface RunJournal {
  runId: string;
  append(event: JournalEvent): Promise<void>;
  read(): AsyncIterable<JournalEvent>;
  summary(): Promise<RunSummary>;
  close(): Promise<void>;
}

export interface OpenJournalOptions {
  dir: string;
  /** When true, journal `task:output` events as well (off by default for size). */
  recordOutput?: boolean;
}

export async function openJournal(runId: string, opts: OpenJournalOptions): Promise<RunJournal> {
  // The journal + summary live inside the run's own subdirectory now, so a
  // single `rm -rf <run-id>/` (or `yaao clean`) is enough to scrub everything
  // about a run — previously they were siblings of the worktree-output dirs.
  const root = resolve(opts.dir);
  const runDir = join(root, runId);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, 'journal.jsonl');
  const summaryPath = join(runDir, 'summary.json');
  const fd = openSync(path, 'a');

  let cachedSummary: RunSummary = await deriveFromFile(runId, path);

  return {
    runId,
    async append(event: JournalEvent) {
      if (event.t === 'task:output' && !opts.recordOutput) return;
      const line = `${JSON.stringify(event)}\n`;
      writeSync(fd, line);
      try {
        fsyncSync(fd);
      } catch {
        // ignore — fsync isn't supported on every fs but the write happened
      }
      cachedSummary = applyEvent(cachedSummary, event);
      writeFileSync(summaryPath, `${JSON.stringify(cachedSummary, null, 2)}\n`);
    },
    async *read() {
      yield* readEvents(path);
    },
    async summary() {
      return cachedSummary;
    },
    async close() {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    },
  };
}

export async function listRuns(dir: string): Promise<RunSummary[]> {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const out: RunSummary[] = [];
  for (const f of readdirSync(root)) {
    const summaryPath = join(root, f, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
      out.push(summary);
    } catch {
      // skip corrupt summaries
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

export async function loadRun(runId: string, dir: string): Promise<{ events: JournalEvent[]; summary: RunSummary }> {
  const path = join(resolve(dir), runId, 'journal.jsonl');
  const events: JournalEvent[] = [];
  for await (const ev of readEvents(path)) events.push(ev);
  const summary = events.reduce<RunSummary>((s, ev) => applyEvent(s, ev), emptySummary(runId));
  return { events, summary };
}

function emptySummary(runId: string): RunSummary {
  return {
    runId,
    planFile: '',
    planHash: '',
    startedAt: '',
    status: 'running',
    tasks: {},
  };
}

async function deriveFromFile(runId: string, path: string): Promise<RunSummary> {
  if (!existsSync(path)) return emptySummary(runId);
  const stats = statSync(path);
  if (stats.size === 0) return emptySummary(runId);
  let s = emptySummary(runId);
  for await (const ev of readEvents(path)) s = applyEvent(s, ev);
  return s;
}

async function* readEvents(path: string): AsyncGenerator<JournalEvent> {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as JournalEvent;
    } catch {
      // skip corrupt line
    }
  }
}

function applyEvent(s: RunSummary, ev: JournalEvent): RunSummary {
  const next: RunSummary = { ...s, tasks: { ...s.tasks } };
  switch (ev.t) {
    case 'run:start':
      next.runId = ev.runId;
      next.planFile = ev.planFile;
      next.planHash = ev.planHash;
      if (ev.planCommit !== undefined) next.planCommit = ev.planCommit;
      if (ev.planBlob !== undefined) next.planBlob = ev.planBlob;
      next.config = ev.config;
      next.startedAt = ev.time;
      next.status = 'running';
      return next;
    case 'task:queued': {
      // Once a task reaches a *verdict* state (completed or failed),
      // transient state events from later runs don't unwind that —
      // sticky-completion means a bug or a skipped follow-up run can't
      // erase real progress, sticky-failed means a resume's fresh
      // task:queued (which the scheduler synchronously emits at
      // construction) doesn't blow away the prior-attempt failure
      // context that runPlan's resume block reads from the summary.
      const cur = next.tasks[ev.taskId];
      if (cur?.status === 'completed' || cur?.status === 'failed') return next;
      next.tasks[ev.taskId] = { ...(cur ?? { status: 'pending' }), status: 'pending' };
      return next;
    }
    case 'task:ready':
      if (next.tasks[ev.taskId]?.status === 'completed') return next;
      next.tasks[ev.taskId] = { ...(next.tasks[ev.taskId] ?? { status: 'ready' }), status: 'ready' };
      return next;
    case 'task:running':
      if (next.tasks[ev.taskId]?.status === 'completed') return next;
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'running' }),
        status: 'running',
        agent: ev.agent,
        branch: ev.branch,
        worktree: ev.worktree,
        ...(ev.cachedFromRunId !== undefined ? { cachedFromRunId: ev.cachedFromRunId } : {}),
      };
      return next;
    case 'task:completed':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'completed' }),
        status: 'completed',
        durationMs: ev.durationMs,
        filesChanged: ev.filesChanged,
        // Empty commit happens on no-op tasks; keep the field so callers see
        // "this task ran but produced nothing" rather than "field missing".
        commit: ev.commit,
        // Lock the agent in to the one that produced the completion. A later
        // task:running (which is ignored by sticky-completion) won't overwrite
        // it, so the status table reports who actually did the work — not who
        // was reassigned and crashed.
        ...(ev.agent !== undefined ? { agent: ev.agent } : {}),
        // Surface the validation verdict's proof. Without this, a caller can't
        // tell from `yaao_status` why a task was considered passing — only
        // that it was.
        ...(ev.validation !== undefined ? { validation: ev.validation } : {}),
      };
      return next;
    case 'task:failed':
      if (next.tasks[ev.taskId]?.status === 'completed') return next;
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'failed' }),
        status: 'failed',
        durationMs: ev.durationMs,
        error: ev.error,
        ...(ev.validation !== undefined ? { validation: ev.validation } : {}),
      };
      return next;
    case 'task:retry-attempt':
      if (next.tasks[ev.taskId]?.status === 'completed') return next;
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'running' }),
        attempts: ev.attempt,
        ...(ev.validation !== undefined ? { validation: ev.validation } : {}),
      };
      return next;
    case 'task:skipped':
      if (next.tasks[ev.taskId]?.status === 'completed') return next;
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'skipped' }),
        status: 'skipped',
        skipReason: ev.reason,
      };
      return next;
    case 'task:merged':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'completed' }),
        mergeStatus: 'merged',
        mergeInto: ev.into,
        mergeCommit: ev.mergeCommit,
      };
      return next;
    case 'task:merge-failed':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'completed' }),
        mergeStatus: 'merge-failed',
        mergeInto: ev.into,
        mergeConflicts: ev.conflicts,
        mergeReason: ev.reason,
      };
      return next;
    case 'run:end':
      next.endedAt = ev.time;
      next.status = ev.status;
      return next;
    default:
      return next;
  }
}

import { createHash } from 'node:crypto';

export function hashPlan(planFileContents: string): string {
  return createHash('sha256').update(planFileContents).digest('hex');
}
