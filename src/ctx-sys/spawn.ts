import { execa, type ResultPromise } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { YaaoError } from '../log/errors.js';

export interface SpawnCtxSysOptions {
  cwd: string;
  bin?: string;
  socketPath?: string;
  spawnTimeoutMs?: number;
}

export interface CtxSysHandle {
  socketPath: string;
  /** PID of the spawned ctx-sys process; 0 when reusing an already-running one. */
  pid: number;
  /** True when this handle started the ctx-sys process. False when an
   * already-running instance was reused. yaao does NOT auto-call `shutdown`
   * at run-end either way — the contract is "spawn if not running, leave it
   * running after the run completes" so the indexer stays warm across runs
   * (F7.1). Tests still call shutdown() to clean up the processes they
   * started. */
  ownsProcess: boolean;
  /** True when this call spawned a new ctx-sys; false when an existing socket
   * was reused. Lets callers report "started" vs "already running" without
   * inspecting pid. */
  spawned: boolean;
  /** Manual shutdown. Yaao itself does not call this at run-end — the
   * lifetime is intentionally "leave it running" so subsequent runs reuse
   * the warm index. No-op when reusing an already-running ctx-sys. */
  shutdown(): Promise<void>;
}

/**
 * Default socket location. Lives under `.ctx-sys/` (ctx-sys's own namespace,
 * not yaao's) so detection + spawn agree on where to look, and so the
 * socket survives `yaao clean` / `yaao_prune` (which scrub `.yaao/`).
 */
function defaultSocketPath(cwd: string): string {
  return join(cwd, '.ctx-sys', 'yaao-mcp.sock');
}

/**
 * Ensure a ctx-sys instance is serving on the project socket. Reuses an
 * already-running instance when its socket is present; otherwise spawns
 * `ctx-sys serve --socket <path>` detached so the child survives yaao
 * exiting at run-end. The runner does not call `handle.shutdown()` —
 * persistence across runs is the entire point: re-indexing on every run
 * defeats the warm cache that makes ctx-sys queries cheap.
 *
 * Stale-socket caveat: a crashed ctx-sys can leave its socket file behind.
 * We don't probe for liveness here (would need a connect attempt + protocol
 * round-trip); a stale socket surfaces as a connection refused when the
 * agent first calls a ctx-sys tool. Recovery is `rm .ctx-sys/yaao-mcp.sock`
 * + re-run. `yaao doctor` (F14.1) is the right place to add a liveness
 * probe.
 */
export async function spawnCtxSys(opts: SpawnCtxSysOptions): Promise<CtxSysHandle> {
  const cwd = resolve(opts.cwd);
  const bin = opts.bin ?? 'ctx-sys';
  const socketPath = opts.socketPath ?? defaultSocketPath(cwd);
  const timeoutMs = opts.spawnTimeoutMs ?? 10_000;

  if (existsSync(socketPath)) {
    return {
      socketPath,
      pid: 0,
      ownsProcess: false,
      spawned: false,
      async shutdown() {
        // Not ours to kill — leave the already-running ctx-sys alone.
      },
    };
  }

  mkdirSync(dirname(socketPath), { recursive: true });

  // `detached: true` puts the child in its own process group so a SIGTERM to
  // yaao (or normal exit) doesn't cascade and kill ctx-sys with it. After
  // the handshake we unref + close our ends of stdout/stderr so the parent's
  // event loop is no longer blocked on the child.
  const child: ResultPromise<{
    cwd: string;
    stdio: ['ignore', 'pipe', 'pipe'];
    reject: false;
    detached: true;
  }> = execa(bin, ['serve', '--socket', socketPath], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    detached: true,
  });

  let resolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const ackReady = (): void => {
    if (!resolved) {
      resolved = true;
      resolveReady();
    }
  };

  // ctx-sys emits its readiness marker (`ctx-sys: ready`, see ctx-sys
  // serve.ts READY_MARKER) on STDERR once the socket listener is bound — stdout
  // is reserved for the MCP/JSON-RPC stream. We watch both streams so the
  // handshake doesn't depend on which one the marker lands on across ctx-sys
  // versions; either matching the regex resolves the ready promise.
  const onChunk = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (/ready|listening/i.test(text)) ackReady();
  };
  child.stderr?.on('data', onChunk);
  child.stdout?.on('data', onChunk);

  const timer = setTimeout(() => {
    if (!resolved) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectReady(
        new YaaoError({
          code: 'YAAO_CTX_SYS_SPAWN_TIMEOUT',
          message: `ctx-sys did not signal ready within ${timeoutMs}ms`,
        }),
      );
    }
  }, timeoutMs);

  child.on('exit', () => {
    clearTimeout(timer);
    if (!resolved) {
      rejectReady(
        new YaaoError({
          code: 'YAAO_CTX_SYS_EXITED',
          message: 'ctx-sys exited before signaling ready',
        }),
      );
    }
  });

  await ready;
  clearTimeout(timer);

  // Detach the child from yaao's event loop now that it's healthy. unref()
  // tells node it's OK to exit even though the child is still running;
  // destroying our stream ends releases the IO handles that would otherwise
  // pin the loop. Together they're what makes "yaao exits, ctx-sys keeps
  // serving" work.
  child.stdout?.removeAllListeners('data');
  child.stderr?.removeAllListeners('data');
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();

  const pid = child.pid ?? 0;
  return {
    socketPath,
    pid,
    ownsProcess: true,
    spawned: true,
    async shutdown() {
      if (!pid) return;
      try {
        // Negative pid signals the whole process group (detached child is a
        // group leader). Belt + braces in case ctx-sys spawned helpers.
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await Promise.race([
        child.catch(() => undefined),
        new Promise<void>((res) => setTimeout(res, 2000)),
      ]);
    },
  };
}
