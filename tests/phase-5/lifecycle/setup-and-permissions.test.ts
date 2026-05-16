import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('task setup + permissions', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('runs setup commands inside the worktree before spawning the agent', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: sp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'sp' },
      tasks: [
        {
          id: 'a',
          title: 'a',
          agent: 'claude-code',
          prompt: 'p',
          setup: ['echo hello > setup-ran.txt'],
        },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });

    let observedCwd = '';
    const observe = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            observedCwd = opts.cwd;
            // After setup runs, the file should already exist when the agent starts.
            expect(existsSync(join(opts.cwd, 'setup-ran.txt'))).toBe(true);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rsetup',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => observe,
    });
    expect(result.status).toBe('success');
    expect(observedCwd).toMatch(/sp\/.*\/a$|\/a$/);
  });

  it('fails the task if a setup command exits non-zero', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: sp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'sp' },
      tasks: [
        { id: 'a', title: 'a', agent: 'claude-code', prompt: 'p', setup: ['exit 7'] },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'never runs' }] });

    let spawned = false;
    const observe = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            spawned = true;
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rsetup-fail',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => observe,
    });
    expect(result.status).toBe('failed');
    expect(spawned).toBe(false);
  });

  it('passes the resolved permission mode through to the backend', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: sp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'sp' },
      tasks: [
        { id: 'a', title: 'a', agent: 'claude-code', prompt: 'p', permissions: 'allow-edits' },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    let seen: string | undefined;
    const observe = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            seen = opts.permissions;
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    await runPlan({
      runId: 'rperms',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => observe,
    });
    expect(seen).toBe('allow-edits');
  });
});
