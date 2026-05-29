import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('F14.9 — runner pre-flight YAAO_BASE_BRANCH_MISSING', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('refuses to start when plan.config.base-branch does not exist in the repo', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: x\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'x' },
      // createTestRepo defaults to 'main'; pin to 'master' to force the miss.
      config: { 'base-branch': 'master' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    await expect(
      runPlan({
        requireTrackedPlan: 'off',
        runId: 'rmiss',
        plan,
        planFile,
        rootDir: cwd,
        config: DEFAULT_CONFIG,
        backendFor: () =>
          new FakeBackend({ events: [{ type: 'stdout', data: 'should not spawn' }] }),
      }),
    ).rejects.toMatchObject({ code: 'YAAO_BASE_BRANCH_MISSING' });
  });

  it('runs cleanly when base-branch matches the actual default', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: x\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'x' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    // createTestRepo's default branch is 'main' — should not raise.
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rok',
      plan,
      planFile,
      rootDir: cwd,
      config: DEFAULT_CONFIG,
      backendFor: () =>
        new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }),
    });
    expect(result.status).toBe('success');
  });
});
