import type { AgentEvent } from '../agents/backend.js';
import type { SchedulerEvent, TaskOutcome } from './scheduler.js';
import type { YaaoError } from '../log/errors.js';
import { EventQueue } from '../agents/backend.js';

export type RunEvent =
  | SchedulerEvent
  | { type: 'task:agent-event'; taskId: string; ev: AgentEvent }
  | { type: 'task:diff'; taskId: string; filesChanged: number; insertions: number; deletions: number }
  | { type: 'task:committed'; taskId: string; sha: string }
  | { type: 'task:merged'; taskId: string; into: string; mergeCommit: string }
  | { type: 'task:merge-failed'; taskId: string; into: string; reason: string; conflicts: string[] }
  | { type: 'run:start'; runId: string; planFile: string }
  | { type: 'run:end'; runId: string; status: 'success' | 'failed' | 'cancelled' }
  | { type: 'task:retry-attempt'; taskId: string; attempt: number; error: YaaoError; outcome: TaskOutcome | undefined };

export interface RunBus {
  emit(ev: RunEvent): void;
  subscribe(fn: (ev: RunEvent) => void): () => void;
  asyncIterator(): AsyncIterable<RunEvent>;
  close(): void;
}

/**
 * Simple in-memory event bus. Sync subscribers see every event in emit() order;
 * async iterators get a per-iterator queue so slow consumers don't drop events.
 */
export function createRunBus(): RunBus {
  const subs = new Set<(ev: RunEvent) => void>();
  const queues = new Set<EventQueue<RunEvent>>();
  let closed = false;
  return {
    emit(ev) {
      if (closed) return;
      for (const s of subs) {
        try {
          s(ev);
        } catch {
          // Sub failures must not break siblings.
        }
      }
      for (const q of queues) q.push(ev);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    asyncIterator() {
      const q = new EventQueue<RunEvent>();
      queues.add(q);
      return q;
    },
    close() {
      closed = true;
      for (const q of queues) q.finish();
      queues.clear();
      subs.clear();
    },
  };
}
