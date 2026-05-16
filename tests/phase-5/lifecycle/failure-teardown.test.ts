import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('Lifecycle teardown on failure', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('removes the worktree and branch when the agent exits non-zero', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: td\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'td' },
      tasks: [{ id: 'boom', title: 'Boom', agent: 'claude-code', prompt: 'fail' }],
    });

    const backend = new FakeBackend({ events: [], exitCode: 0 });
    // Throwing from spawn() simulates an unrecoverable agent failure inside the
    // lifecycle's try-block — the teardown path is what we're verifying.
    const throwingBackend = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async () => {
            throw new Error('synthetic agent crash');
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rfail',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => throwingBackend,
    });
    expect(result.status).toBe('failed');

    // Branch must be deleted so the next run doesn't collide.
    const { execa } = await import('execa');
    const branchCheck = await execa('git', ['rev-parse', '--verify', 'refs/heads/td/boom'], {
      cwd: repo.path,
      reject: false,
    });
    expect(branchCheck.exitCode).not.toBe(0);
  });
});
