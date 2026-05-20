import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append a `run:end status=cancelled` line to a run's journal, synchronously.
 * Designed to be called from a SIGINT/SIGTERM handler — the writes need to
 * complete before we re-raise the signal, so we use the sync fs API rather
 * than going through the async RunJournal interface.
 *
 * Idempotent on missing journals (no-op) so a signal that fires before
 * runPlan opened the journal doesn't crash the process. If the journal
 * already has a run:end line the consumer's summary derivation just sees
 * whichever appears last — also fine.
 */
export interface AppendCancelOptions {
  /** Project root — the same `rootDir` runPlan was given. */
  cwd: string;
  /** The run id whose journal should receive the cancel marker. */
  runId: string;
  /** Override for tests. Defaults to <cwd>/.yaao/runs. */
  journalDir?: string;
  /** Elapsed wall-clock (ms) since runPlan was called. 0 is a reasonable
   * fallback when the caller didn't track a start time — the journal still
   * carries the run-start and run-end timestamps for precise derivation. */
  durationMs?: number;
}

export function appendCancelToJournal(opts: AppendCancelOptions): void {
  const dir = opts.journalDir ?? join(opts.cwd, '.yaao', 'runs');
  const journalPath = join(dir, opts.runId, 'journal.jsonl');
  if (!existsSync(journalPath)) return;
  const line = JSON.stringify({
    t: 'run:end',
    time: new Date().toISOString(),
    status: 'cancelled',
    durationMs: opts.durationMs ?? 0,
  }) + '\n';
  try {
    appendFileSync(journalPath, line);
  } catch {
    // Best-effort. If the disk is wedged we still want the signal handler to
    // re-raise and let the process exit; logging from a signal handler is
    // unreliable.
  }
}
