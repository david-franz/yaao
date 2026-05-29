import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotBackend } from '../../../src/agents/copilot.js';
import { hasBinary, liveTestGate } from './_helpers.js';

// gh + gh auth is the bar; the gh-copilot extension's agentic surface is
// what F14.7 will verify. This test surfaces breakage either way: if gh
// isn't installed it skips; if it is and gh copilot agent run doesn't
// work, the test fails with the underlying error which F14.7 will use as
// input to its Stage 1 / Stage 2 decision.
const gate = liveTestGate('copilot', hasBinary('gh'));

describe.skipIf(!gate.ok)(
  `F14.4 — copilot live smoke (${gate.ok ? 'running' : `skipped: ${gate.reason}`})`,
  () => {
    it('spawns gh copilot agent run against a trivial prompt', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'yaao-live-copilot-'));
      const backend = new CopilotBackend();
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
