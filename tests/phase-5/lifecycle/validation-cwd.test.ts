import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('validation.cwd', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('runs the validation command inside the configured subdirectory', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vc\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'vc' },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'p',
          validation: {
            command: 'test -f marker.txt',
            'must-pass': true,
            cwd: 'apps/api',
          },
        },
      ],
    });

    // The fake agent writes the marker inside apps/api so the cwd-scoped
    // validation finds it; a worktree-root-scoped validation would not.
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            mkdirSync(join(opts.cwd, 'apps', 'api'), { recursive: true });
            writeFileSync(join(opts.cwd, 'apps', 'api', 'marker.txt'), 'ok');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rvc',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');
  });
});
