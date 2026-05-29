import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from '../git/journal.js';

/**
 * F15.1 — Orphan-run detection.
 *
 * A run is orphaned when ALL THREE hold:
 *   1. summary.status === 'running'
 *   2. The journal hasn't been appended to in > STALE_MS (default 60s)
 *   3. EITHER no runner.pid file exists in the run dir, OR the pid in
 *      that file fails process.kill(pid, 0) (i.e. the process is gone)
 *
 * Same primitive consumed by yaao doctor and the yaao_inspect workspace
 * status pill, so "is this run actually alive?" has one source of truth.
 */

export const ORPHAN_STALE_MS = 60_000;

export interface OrphanDetectionInput {
  runDir: string;
  summary: Pick<RunSummary, 'status'>;
  /** Override for tests; defaults to process.kill. */
  isPidAlive?: (pid: number) => boolean;
  /** Override for tests; defaults to Date.now. */
  now?: number;
  /** Override stale window for tests. */
  staleMs?: number;
}

export interface OrphanDetectionResult {
  orphaned: boolean;
  reason: string;
}

export function detectOrphan(input: OrphanDetectionInput): OrphanDetectionResult {
  const status = input.summary.status;
  if (status !== 'running') {
    return { orphaned: false, reason: `status is '${status}' (not running)` };
  }
  const journalPath = join(input.runDir, 'journal.jsonl');
  if (!existsSync(journalPath)) {
    return { orphaned: true, reason: 'journal.jsonl is missing' };
  }
  const stat = statSync(journalPath);
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? ORPHAN_STALE_MS;
  const ageMs = now - stat.mtimeMs;
  if (ageMs < staleMs) {
    return {
      orphaned: false,
      reason: `journal recently written (${Math.round(ageMs / 1000)}s ago)`,
    };
  }
  // Journal is stale. Check pid liveness.
  const pidPath = join(input.runDir, 'runner.pid');
  if (!existsSync(pidPath)) {
    return {
      orphaned: true,
      reason: `journal stale (${Math.round(ageMs / 1000)}s old) and no runner.pid file`,
    };
  }
  const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      orphaned: true,
      reason: 'runner.pid is unreadable or non-numeric',
    };
  }
  const alive = (input.isPidAlive ?? defaultIsPidAlive)(pid);
  if (!alive) {
    return {
      orphaned: true,
      reason: `runner pid ${pid} is no longer alive`,
    };
  }
  return { orphaned: false, reason: `runner pid ${pid} is still alive` };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal; it only checks whether
    // we can. Returns true when the process exists and we have
    // permission, throws ESRCH when it doesn't.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ESRCH') return false;
    // EPERM means the process exists but we can't signal it — still alive.
    if (e.code === 'EPERM') return true;
    return false;
  }
}
