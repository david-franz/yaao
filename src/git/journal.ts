import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface SerializedConfigSubset {
  baseBranch: string;
  maxParallel: number;
}

export type JournalEvent =
  | { t: 'run:start'; time: string; runId: string; planFile: string; planHash: string; config: SerializedConfigSubset }
  | { t: 'task:queued'; time: string; taskId: string; depends: string[] }
  | { t: 'task:ready'; time: string; taskId: string }
  | { t: 'task:running'; time: string; taskId: string; agent: string; model?: string; worktree: string; branch: string; pid: number }
  | { t: 'task:output'; time: string; taskId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { t: 'task:completed'; time: string; taskId: string; durationMs: number; filesChanged: number; commit: string }
  | { t: 'task:failed'; time: string; taskId: string; durationMs: number; error: { code: string; message: string } }
  | { t: 'task:skipped'; time: string; taskId: string; reason: 'depFailed' | 'filtered' }
  | { t: 'merge:start'; time: string; taskId: string; into: string }
  | { t: 'merge:conflict'; time: string; taskId: string; files: string[] }
  | { t: 'merge:resolved'; time: string; taskId: string; by: 'auto' | 'agent' | 'manual'; commit: string }
  | { t: 'run:end'; time: string; status: 'success' | 'failed' | 'cancelled'; durationMs: number };

export interface RunSummary {
  runId: string;
  planFile: string;
  planHash: string;
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
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.jsonl`);
  const summaryPath = join(dir, `${runId}.summary.json`);
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
    if (!f.endsWith('.summary.json')) continue;
    try {
      const summary = JSON.parse(readFileSync(join(root, f), 'utf8')) as RunSummary;
      out.push(summary);
    } catch {
      // skip corrupt summaries
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

export async function loadRun(runId: string, dir: string): Promise<{ events: JournalEvent[]; summary: RunSummary }> {
  const path = join(resolve(dir), `${runId}.jsonl`);
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
      next.startedAt = ev.time;
      next.status = 'running';
      return next;
    case 'task:queued':
      next.tasks[ev.taskId] = { ...(next.tasks[ev.taskId] ?? { status: 'pending' }), status: 'pending' };
      return next;
    case 'task:ready':
      next.tasks[ev.taskId] = { ...(next.tasks[ev.taskId] ?? { status: 'ready' }), status: 'ready' };
      return next;
    case 'task:running':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'running' }),
        status: 'running',
        agent: ev.agent,
        branch: ev.branch,
        worktree: ev.worktree,
      };
      return next;
    case 'task:completed':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'completed' }),
        status: 'completed',
        durationMs: ev.durationMs,
      };
      return next;
    case 'task:failed':
      next.tasks[ev.taskId] = {
        ...(next.tasks[ev.taskId] ?? { status: 'failed' }),
        status: 'failed',
        durationMs: ev.durationMs,
        error: ev.error,
      };
      return next;
    case 'task:skipped':
      next.tasks[ev.taskId] = { ...(next.tasks[ev.taskId] ?? { status: 'skipped' }), status: 'skipped' };
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
