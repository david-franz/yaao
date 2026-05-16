import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';
import type { YaaoError } from '../log/errors.js';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface TaskOutcome {
  filesChanged?: number;
  commit?: string;
  durationMs?: number;
}

export type SchedulerEvent =
  | { type: 'task:queued'; taskId: string; depends: string[] }
  | { type: 'task:ready'; taskId: string }
  | { type: 'task:active'; taskId: string }
  | { type: 'task:completed'; taskId: string; outcome: TaskOutcome }
  | { type: 'task:failed'; taskId: string; error: YaaoError }
  | { type: 'task:skipped'; taskId: string; reason: 'filtered' | 'depFailed' };

export interface SchedulerOptions {
  plan: ResolvedPlan;
  filter?: { only?: string[]; skip?: string[] };
  maxParallel: number;
  /** Listener invoked synchronously on every transition. */
  onEvent?: (ev: SchedulerEvent) => void;
}

interface TaskState {
  task: ResolvedTask;
  status: TaskStatus;
  attempt: number;
  reason?: 'filtered' | 'depFailed';
}

export class Scheduler {
  private readonly tasks = new Map<string, TaskState>();
  private readonly active = new Set<string>();
  private readonly children = new Map<string, string[]>();
  private readonly maxParallel: number;
  private readonly listener: ((ev: SchedulerEvent) => void) | undefined;

  constructor(opts: SchedulerOptions) {
    this.maxParallel = Math.max(1, opts.maxParallel);
    this.listener = opts.onEvent;

    for (const t of opts.plan.tasks) {
      this.tasks.set(t.id, { task: t, status: 'pending', attempt: 0 });
      for (const dep of t.depends) {
        const arr = this.children.get(dep) ?? [];
        arr.push(t.id);
        this.children.set(dep, arr);
      }
    }

    // Apply filters before any other transitions so the initial event stream is consistent.
    if (opts.filter?.only && opts.filter?.skip) {
      throw new Error('--only and --skip are mutually exclusive');
    }
    if (opts.filter?.only) {
      const closure = this.transitiveDepClosure(opts.filter.only);
      for (const id of this.tasks.keys()) {
        if (!closure.has(id)) this.markSkipped(id, 'filtered');
      }
    }
    if (opts.filter?.skip) {
      for (const id of opts.filter.skip) {
        if (this.tasks.has(id)) this.cascadeSkip(id, 'filtered');
      }
    }

    for (const [id, state] of this.tasks) {
      if (state.status === 'pending') {
        this.emit({ type: 'task:queued', taskId: id, depends: state.task.depends });
      }
    }
    this.refreshReady();
  }

  status(id: string): TaskStatus {
    return this.tasks.get(id)?.status ?? 'pending';
  }

  /** Pure inspector; returns IDs eligible to run, capped to (maxParallel - active). */
  readyTasks(): string[] {
    const slots = this.maxParallel - this.active.size;
    if (slots <= 0) return [];
    const ids: { id: string; downstream: number }[] = [];
    for (const [id, state] of this.tasks) {
      if (state.status === 'ready') {
        ids.push({ id, downstream: this.descendantCount(id) });
      }
    }
    ids.sort((a, b) => b.downstream - a.downstream || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return ids.slice(0, slots).map((x) => x.id);
  }

  startTask(id: string): void {
    const state = this.tasks.get(id);
    if (!state) throw new Error(`unknown task: ${id}`);
    if (state.status !== 'ready') throw new Error(`task ${id} is not ready (status=${state.status})`);
    state.status = 'active';
    this.active.add(id);
    this.emit({ type: 'task:active', taskId: id });
  }

  completeTask(id: string, outcome: TaskOutcome): void {
    const state = this.tasks.get(id);
    if (!state) throw new Error(`unknown task: ${id}`);
    state.status = 'completed';
    this.active.delete(id);
    this.emit({ type: 'task:completed', taskId: id, outcome });
    this.refreshReady();
  }

  failTask(id: string, error: YaaoError): void {
    const state = this.tasks.get(id);
    if (!state) throw new Error(`unknown task: ${id}`);
    this.active.delete(id);
    // Retry policy is owned by the lifecycle; by the time the scheduler is told
    // a task failed, all retries (if any) have been exhausted, so we always
    // mark failed and cascade-skip downstream tasks.
    state.status = 'failed';
    this.emit({ type: 'task:failed', taskId: id, error });
    for (const child of this.children.get(id) ?? []) this.cascadeSkip(child, 'depFailed');
  }

  cancelTask(id: string, _reason: string): void {
    const state = this.tasks.get(id);
    if (!state) throw new Error(`unknown task: ${id}`);
    state.status = 'cancelled';
    this.active.delete(id);
    for (const child of this.children.get(id) ?? []) this.cascadeSkip(child, 'depFailed');
  }

  retryTask(id: string): void {
    const state = this.tasks.get(id);
    if (!state) throw new Error(`unknown task: ${id}`);
    if (state.status !== 'pending') return;
    this.refreshReady();
  }

  done(): boolean {
    for (const s of this.tasks.values()) {
      if (s.status === 'pending' || s.status === 'ready' || s.status === 'active') return false;
    }
    return true;
  }

  /** Snapshot every task's status — handy for debugging and tests. */
  snapshot(): Record<string, TaskStatus> {
    const out: Record<string, TaskStatus> = {};
    for (const [id, s] of this.tasks) out[id] = s.status;
    return out;
  }

  private emit(ev: SchedulerEvent): void {
    this.listener?.(ev);
  }

  private refreshReady(): void {
    for (const [id, state] of this.tasks) {
      if (state.status !== 'pending') continue;
      const allDepsDone = state.task.depends.every((d) => {
        const ds = this.tasks.get(d);
        return ds?.status === 'completed' || ds?.status === 'skipped';
      });
      // If any required dep is skipped (not by filter — by depFailed), this task should
      // also have been cascade-skipped already; refreshReady runs after that.
      if (!allDepsDone) continue;
      const anyDepFailed = state.task.depends.some((d) => this.tasks.get(d)?.status === 'failed');
      if (anyDepFailed) {
        this.cascadeSkip(id, 'depFailed');
        continue;
      }
      state.status = 'ready';
      this.emit({ type: 'task:ready', taskId: id });
    }
  }

  private cascadeSkip(id: string, reason: 'filtered' | 'depFailed'): void {
    const state = this.tasks.get(id);
    if (!state) return;
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') return;
    if (state.status === 'skipped') return;
    state.status = 'skipped';
    state.reason = reason;
    this.emit({ type: 'task:skipped', taskId: id, reason });
    for (const child of this.children.get(id) ?? []) this.cascadeSkip(child, 'depFailed');
  }

  private markSkipped(id: string, reason: 'filtered' | 'depFailed'): void {
    const state = this.tasks.get(id);
    if (!state) return;
    state.status = 'skipped';
    state.reason = reason;
    this.emit({ type: 'task:skipped', taskId: id, reason });
  }

  /** Returns the set of tasks that includes the given seeds and all their transitive deps. */
  private transitiveDepClosure(seeds: string[]): Set<string> {
    const out = new Set<string>();
    const visit = (id: string): void => {
      if (out.has(id)) return;
      out.add(id);
      const t = this.tasks.get(id);
      if (!t) return;
      for (const dep of t.task.depends) visit(dep);
    };
    for (const s of seeds) visit(s);
    return out;
  }

  private descendantCount(id: string, seen = new Set<string>()): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    let n = 0;
    for (const c of this.children.get(id) ?? []) {
      n += 1 + this.descendantCount(c, seen);
    }
    return n;
  }
}
