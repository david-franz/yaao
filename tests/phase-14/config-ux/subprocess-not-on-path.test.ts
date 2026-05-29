import { describe, it, expect } from 'vitest';
import { SubprocessBackend } from '../../../src/agents/subprocess.js';

describe('F14.8 — SubprocessBackend.isAvailable rendering when binary is missing', () => {
  it("reports 'binary not found on PATH' instead of 'exited -1'", async () => {
    const backend = new SubprocessBackend({
      name: 'codex',
      bin: '/nonexistent/binary/yaao-f14-8-test',
      buildArgs: () => [],
    });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toMatch(/not found on PATH/);
      // The legacy nonsense formatter must not appear.
      expect(r.reason).not.toMatch(/exited -1/);
    }
  });
});
