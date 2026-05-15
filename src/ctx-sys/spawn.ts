import { execa, type ResultPromise } from 'execa';
import { mkdirSync } from 'node:fs';
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
  pid: number;
  shutdown(): Promise<void>;
}

/**
 * Spawn `ctx-sys serve --socket <path>` and wait for the socket to appear (or a "ready"
 * line on stdout). The handle's `shutdown()` SIGTERMs the process and waits briefly for
 * exit; the runner owns the lifecycle.
 */
export async function spawnCtxSys(opts: SpawnCtxSysOptions): Promise<CtxSysHandle> {
  const cwd = resolve(opts.cwd);
  const bin = opts.bin ?? 'ctx-sys';
  const socketPath = opts.socketPath ?? join(cwd, '.yaao', 'ctx-sys.sock');
  const timeoutMs = opts.spawnTimeoutMs ?? 10_000;
  mkdirSync(dirname(socketPath), { recursive: true });

  const child: ResultPromise<{ cwd: string; stdio: ['ignore', 'pipe', 'pipe']; reject: false }> = execa(
    bin,
    ['serve', '--socket', socketPath],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], reject: false },
  );

  let resolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const ackReady = () => {
    if (!resolved) {
      resolved = true;
      resolveReady();
    }
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (/ready|listening/i.test(text)) ackReady();
  });
  child.stderr?.on('data', () => {
    /* drained */
  });

  const timer = setTimeout(() => {
    if (!resolved) {
      child.kill('SIGTERM');
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

  return {
    socketPath,
    pid: child.pid ?? 0,
    async shutdown() {
      if (!child.pid) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      try {
        await Promise.race([
          child,
          new Promise<void>((res) => setTimeout(res, 2000)),
        ]);
      } catch {
        // ignore
      }
    },
  };
}
