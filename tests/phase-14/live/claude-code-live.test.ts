import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeBackend } from '../../../src/agents/claude-code.js';
import { hasBinary, liveTestGate } from './_helpers.js';

const gate = liveTestGate('claude_code', hasBinary('claude'));

describe.skipIf(!gate.ok)(
  `F14.4 — claude-code live smoke (${gate.ok ? 'running' : `skipped: ${gate.reason}`})`,
  () => {
    it('spawns claude, produces a hello.txt, exits 0', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'yaao-live-claude-'));
      const backend = new ClaudeCodeBackend();
      const proc = await backend.spawn({
        cwd,
        prompt: 'Create a file called hello.txt containing the single word ok.',
        permissions: 'allow-all',
        timeout: 60_000,
      });
      // Drain events so the child can complete.
      for await (const _ev of proc.events) void _ev;
      const result = await proc.completed;
      expect(result.exitCode).toBe(0);
      const helloPath = join(cwd, 'hello.txt');
      expect(existsSync(helloPath)).toBe(true);
      expect(readFileSync(helloPath, 'utf8').trim()).toBe('ok');
    }, 90_000);
  },
);
