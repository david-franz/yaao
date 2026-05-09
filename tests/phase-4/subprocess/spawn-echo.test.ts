import { describe, it, expect } from 'vitest';
import { SubprocessBackend } from '../../../src/agents/subprocess.js';
import { AgentUnavailableError } from '../../../src/log/errors.js';
import type { SpawnOptions } from '../../../src/agents/backend.js';

describe('SubprocessBackend: live spawn against `node`', () => {
  it('streams stdout from a real subprocess and reports exit 0', async () => {
    const backend = new SubprocessBackend({
      name: 'codex',
      bin: process.execPath, // node itself — guaranteed available in CI
      buildArgs: () => ['-e', 'console.log("hello"); console.log("world");'],
      promptOnStdin: false,
    });
    const avail = await backend.isAvailable();
    expect(avail.available).toBe(true);
    const proc = await backend.spawn({ cwd: process.cwd(), prompt: '' } satisfies SpawnOptions);
    const out: string[] = [];
    for await (const ev of proc.events) out.push(ev.data);
    const r = await proc.completed;
    expect(r.exitCode).toBe(0);
    expect(out).toEqual(['hello', 'world']);
  });

  it('rejects spawn() when the binary is missing', async () => {
    const backend = new SubprocessBackend({
      name: 'codex',
      bin: '/nonexistent/binary/path-yaao-test',
      buildArgs: () => [],
    });
    const avail = await backend.isAvailable();
    expect(avail.available).toBe(false);
    await expect(
      backend.spawn({ cwd: process.cwd(), prompt: '' }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});
