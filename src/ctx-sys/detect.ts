import { execa } from 'execa';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { YaaoConfig } from '../config/types.js';

export interface CtxSysStatus {
  installed: boolean;
  initialized: boolean;
  running: boolean;
  socketPath?: string;
  version?: string;
  /** True if `.ctx-sys/db.sqlite` exists and reports at least one indexed entity. */
  indexed?: boolean;
  /** Reason populated when the status reports a problem (e.g. missing index). */
  reason?: string;
}

export interface DetectOptions {
  cwd: string;
  config: YaaoConfig;
  /** Test injection: override the `ctx-sys` binary name. */
  bin?: string;
}

/**
 * Probe ctx-sys against the project. Pure inspection — never spawns. The caller (F7.1's
 * spawn step) decides what to do with the report.
 */
export async function detectCtxSys(opts: DetectOptions): Promise<CtxSysStatus> {
  const status: CtxSysStatus = { installed: false, initialized: false, running: false };
  const cwd = resolve(opts.cwd);
  const bin = opts.bin ?? 'ctx-sys';

  // 1) Is the ctx-sys binary on PATH? We don't return early — initialization/index
  //    state is still useful information even when the binary is missing (e.g. for
  //    `yaao doctor` to recommend installing it).
  try {
    const versionProbe = await execa(bin, ['--version'], { reject: false });
    if (typeof versionProbe.exitCode === 'number' && versionProbe.exitCode === 0) {
      status.installed = true;
      status.version = (versionProbe.stdout?.toString() ?? '').trim().split(/\s+/).pop();
    } else {
      status.reason = `${bin} --version exited ${versionProbe.exitCode ?? '?'}`;
    }
  } catch (err) {
    status.reason = (err as Error).message;
  }

  // 2) Is the project initialized for ctx-sys? Walk up looking for `.ctx-sys/`.
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.ctx-sys'))) {
      status.initialized = true;
      break;
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3) Is there a project socket? If so, ctx-sys is already serving.
  const sock = join(cwd, '.ctx-sys', 'yaao-mcp.sock');
  if (existsSync(sock)) {
    status.running = true;
    status.socketPath = sock;
  }

  // 4) Is the index present and non-empty? `ctx-sys status --json` would be the canonical
  // probe; we fall back to inspecting the on-disk DB file.
  if (status.initialized) {
    const dbPath = join(dir, '.ctx-sys', 'db.sqlite');
    if (existsSync(dbPath)) {
      try {
        status.indexed = statSync(dbPath).size > 0;
      } catch {
        status.indexed = false;
      }
    } else {
      status.indexed = false;
    }
    if (status.indexed === false) {
      status.reason = 'project initialized but the ctx-sys index is empty; run `ctx-sys index`';
    }
  }
  return status;
}
