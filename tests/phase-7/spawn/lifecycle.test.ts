import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCtxSys } from '../../../src/ctx-sys/spawn.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('spawnCtxSys: handshake lifecycle', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('resolves when the fake child prints "ready"', async () => {
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
      expect(handle.socketPath).toContain('.yaao/ctx-sys.sock');
    } finally {
      await handle.shutdown();
    }
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
