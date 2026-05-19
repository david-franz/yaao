import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('validation that looks like prose', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('surfaces a helpful "looks like prose" hint when sh exits 127 on a natural-language command', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: pv\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'pv' },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'p',
          retries: 0,
          // Natural-language instruction the agent (or planner) wrote into
          // validation.command — yaao runs it via sh and gets exit 127.
          validation: {
            command: 'Open index.html in browser and confirm no console errors',
            'must-pass': true,
          },
        },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'index.html'), '<html></html>');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const failures: { msg: string }[] = [];
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
      onProgress: (ev) => {
        if (ev.type === 'task:failed') failures.push({ msg: ev.error.message });
      },
    });
    expect(result.status).toBe('failed');
    expect(failures[0]?.msg).toMatch(/looks like natural-language prose/);
    expect(failures[0]?.msg).toMatch(/Open index\.html in browser/);
  });
});
