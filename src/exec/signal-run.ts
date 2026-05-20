import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-process cancel for a yaao run.
 *
 * Every runPlan invocation writes `runner.pid` into the run's journal
 * directory; this helper reads that file, verifies the pid is alive, and
 * sends SIGTERM. The runner's existing SIGTERM handler ([5a05f8c]) stamps
 * `run:end status=cancelled` in the journal before re-raising, so
 * `yaao_inspect` / web workspace / `yaao status` all flip away from
 * `running` cleanly.
 *
 * Three surfaces use this same helper: `yaao stop <runId>` (CLI),
 * `yaao_stop({runId})` (MCP), and the web RunDetail Cancel button. Single
 * source of truth for "request that a run stop."
 *
 * Pid-recycle caveat: if yaao crashes hard enough to leave runner.pid
 * behind AND the OS later reuses that pid for an unrelated process, we'd
 * SIGTERM that process. Modern pid spaces are large enough that this is
 * exceedingly rare in practice; the kill(pid, 0) alive-check below is
 * the only mitigation. A more robust check (matching argv against
 * 'yaao') is possible but cross-platform fragile; defer.
 */

export interface SignalRunOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd: string;
  runId: string;
  /** Override for tests. Defaults to <cwd>/.yaao/runs. */
  journalDir?: string;
  /** Signal name. SIGTERM is the only one the runner's handler stamps
   * `cancelled` for; left configurable mostly for tests. */
  signal?: NodeJS.Signals;
}

export interface SignalRunResult {
  signaled: boolean;
  /** Machine-readable explanation when signaled=false. */
  reason: 'no-pid-file' | 'pid-dead' | 'kill-failed' | 'sent';
  pid?: number;
  /** Free-form human hint surfaced by the CLI / MCP envelope. */
  hint?: string;
}

export function signalRun(opts: SignalRunOptions): SignalRunResult {
  const dir = opts.journalDir ?? join(opts.cwd, '.yaao', 'runs');
  const pidPath = join(dir, opts.runId, 'runner.pid');
  if (!existsSync(pidPath)) {
    return {
      signaled: false,
      reason: 'no-pid-file',
      hint:
        'no runner.pid for this run — either it already finished, or it was started by a yaao before the pid-tracking change',
    };
  }
  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  } catch {
    return { signaled: false, reason: 'no-pid-file', hint: 'pid file unreadable' };
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return { signaled: false, reason: 'no-pid-file', hint: 'pid file empty or malformed' };
  }
  // kill(pid, 0) is the standard POSIX alive-check — no signal sent, just
  // returns ESRCH if the process is gone. Throws on permission errors,
  // which we treat as "dead" too (we wouldn't be able to signal anyway).
  try {
    process.kill(pid, 0);
  } catch {
    return {
      signaled: false,
      reason: 'pid-dead',
      pid,
      hint: 'pid is stale — the runner has already exited',
    };
  }
  try {
    process.kill(pid, opts.signal ?? 'SIGTERM');
    return { signaled: true, reason: 'sent', pid };
  } catch (e) {
    return {
      signaled: false,
      reason: 'kill-failed',
      pid,
      hint: `signal failed: ${(e as Error).message}`,
    };
  }
}
