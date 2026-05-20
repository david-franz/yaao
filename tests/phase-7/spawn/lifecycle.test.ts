import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCtxSys } from '../../../src/ctx-sys/spawn.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('spawnCtxSys: handshake lifecycle', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('resolves when the fake child prints "ready" and writes to the canonical socket path', async () => {
    project = createTmpProject();
    mkdirSync(join(project.path, 'bin'), { recursive: true });
    const fakeBin = join(project.path, 'bin', 'ctx-sys');
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
process.stdout.write('listening on socket\\n');
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeBin, 0o755);

    const handle = await spawnCtxSys({
      cwd: project.path,
      bin: fakeBin,
      spawnTimeoutMs: 5000,
    });
    try {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.ownsProcess).toBe(true);
      expect(handle.spawned).toBe(true);
      // Socket lives under `.ctx-sys/` so detect + spawn agree on where
      // a warm instance is found, and so `yaao clean` (which scrubs
      // `.yaao/`) doesn't accidentally take ctx-sys down with it.
      expect(handle.socketPath).toContain('.ctx-sys/yaao-mcp.sock');
    } finally {
      await handle.shutdown();
    }
  });

  it('reuses an already-running ctx-sys when its socket is present (no spawn, no shutdown)', async () => {
    project = createTmpProject();
    const sockPath = join(project.path, '.ctx-sys', 'yaao-mcp.sock');
    mkdirSync(join(project.path, '.ctx-sys'), { recursive: true });
    // The "socket" can be any file for this test — spawn only checks
    // existence, not the protocol. A stale socket would also match;
    // F14.1 (yaao doctor) is the right place for a liveness probe.
    writeFileSync(sockPath, '');

    const handle = await spawnCtxSys({
      cwd: project.path,
      // The bin name is irrelevant because we should never invoke it.
      bin: '/nonexistent/ctx-sys',
      spawnTimeoutMs: 1000,
    });
    expect(handle.pid).toBe(0);
    expect(handle.ownsProcess).toBe(false);
    expect(handle.spawned).toBe(false);
    expect(handle.socketPath).toBe(sockPath);
    await handle.shutdown(); // no-op; must not throw
    // Socket should still be there — we did not own it, so we did not remove it.
    expect(existsSync(sockPath)).toBe(true);
  });

  it('rejects with a timeout if the child never signals ready', async () => {
    project = createTmpProject();
    mkdirSync(join(project.path, 'bin'), { recursive: true });
    const fakeBin = join(project.path, 'bin', 'ctx-sys');
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeBin, 0o755);

    await expect(
      spawnCtxSys({ cwd: project.path, bin: fakeBin, spawnTimeoutMs: 200 }),
    ).rejects.toThrowError(/ready/);
  });
});
