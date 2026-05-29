import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBackend } from '../../../src/agents/codex.js';
import { hasBinary, liveTestGate } from './_helpers.js';

const gate = liveTestGate('codex', hasBinary('codex'));

describe.skipIf(!gate.ok)(
  `F14.4 — codex live smoke (${gate.ok ? 'running' : `skipped: ${gate.reason}`})`,
  () => {
    it('spawns codex exec against a trivial prompt and exits cleanly', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'yaao-live-codex-'));
      const backend = new CodexBackend();
      const proc = await backend.spawn({
        cwd,
        prompt: 'Create a file called hello.txt containing the single word ok.',
        timeout: 60_000,
      });
      for await (const _ev of proc.events) void _ev;
      const result = await proc.completed;
      expect(result.exitCode).toBe(0);
      const helloPath = join(cwd, 'hello.txt');
      expect(existsSync(helloPath)).toBe(true);
      expect(readFileSync(helloPath, 'utf8').trim()).toBe('ok');
    }, 90_000);
  },
);
