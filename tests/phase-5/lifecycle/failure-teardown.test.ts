import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('Lifecycle on failure', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('preserves the worktree and branch on failure so the user can inspect', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: td\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'td' },
      tasks: [{ id: 'boom', title: 'Boom', agent: 'claude-code', prompt: 'fail' }],
    });

    const backend = new FakeBackend({ events: [], exitCode: 0 });
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
      requireTrackedPlan: 'off',
      runId: 'rfail',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => throwingBackend,
    });
    expect(result.status).toBe('failed');

    // The worktree and branch should still exist so the user can inspect them.
    const wtPath = join(repo.path, '.yaao', 'worktrees', 'rfail', 'boom');
    expect(existsSync(wtPath)).toBe(true);
    const { execa } = await import('execa');
    const branchCheck = await execa('git', ['rev-parse', '--verify', 'refs/heads/td/boom'], {
      cwd: repo.path,
      reject: false,
    });
    expect(branchCheck.exitCode).toBe(0);
  });
});
