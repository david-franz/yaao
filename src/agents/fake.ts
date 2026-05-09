import type {
  AgentBackend,
  AgentEvent,
  AgentName,
  AgentProcess,
  AgentResult,
  AvailabilityReport,
  SpawnOptions,
} from './backend.js';
import { EventQueue, nowIso } from './backend.js';
import { AgentCancelledError, AgentTimeoutError } from '../log/errors.js';

export interface FakeBackendScript {
  /** Events to emit, in order. */
  events: Omit<AgentEvent, 'timestamp'>[];
  /** Delay (ms) between events; 0 by default. */
  delayMs?: number;
  /** Final exit code. */
  exitCode?: number;
  /** Number of tool-use events to claim in `AgentResult.toolUseCount`. */
  toolUseCount?: number;
  /** When set, isAvailable returns this. Default: { available: true, version: 'fake' }. */
  availability?: AvailabilityReport;
}

/**
 * Test-only deterministic backend. Emits scripted events and resolves with a known result.
 * Conformance suite + execution-engine tests use this in place of a real CLI.
 */
export class FakeBackend implements AgentBackend {
  readonly name: AgentName;
  constructor(
    public readonly script: FakeBackendScript,
    name: AgentName = 'claude-code',
  ) {
    this.name = name;
  }

  async isAvailable(): Promise<AvailabilityReport> {
    return this.script.availability ?? { available: true, version: 'fake' };
  }

  async spawn(opts: SpawnOptions): Promise<AgentProcess> {
    const queue = new EventQueue<AgentEvent>();
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let resolveResult!: (r: AgentResult) => void;
    let rejectResult!: (e: Error) => void;
    const completed = new Promise<AgentResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      queue.finish();
      if (timer) clearTimeout(timer);
      if (err) rejectResult(err);
      else
        resolveResult({
          exitCode: this.script.exitCode ?? 0,
          stdout,
          stderr,
          toolUseCount: this.script.toolUseCount ?? 0,
          mcpToolCalls: [],
          durationMs: Date.now() - start,
        });
    };

    if (opts.timeout) {
      timer = setTimeout(() => {
        finish(
          new AgentTimeoutError({
            message: `agent timed out after ${opts.timeout}ms`,
            agent: this.name,
            timeoutMs: opts.timeout ?? 0,
          }),
        );
      }, opts.timeout);
    }

    if (opts.signal) {
      const onAbort = () => {
        finish(
          new AgentCancelledError({
            message: `agent cancelled${opts.signal?.reason ? `: ${opts.signal.reason}` : ''}`,
            agent: this.name,
          }),
        );
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    void (async () => {
      const delay = this.script.delayMs ?? 0;
      for (const ev of this.script.events) {
        if (settled) return;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (settled) return;
        const stamped: AgentEvent = { ...ev, timestamp: nowIso() };
        if (ev.type === 'stdout') stdout += ev.data;
        else if (ev.type === 'stderr') stderr += ev.data;
        queue.push(stamped);
      }
      if (!settled) finish();
    })();

    return {
      pid: 0,
      events: queue,
      completed,
      cancel: async (reason) => {
        finish(
          new AgentCancelledError({
            message: `agent cancelled${reason ? `: ${reason}` : ''}`,
            agent: this.name,
            reason,
          }),
        );
      },
    };
  }
}
