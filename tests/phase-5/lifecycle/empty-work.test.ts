import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('agent produced no new work', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('fails a task whose agent left the worktree unchanged and has a validation command', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: ew\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'ew' },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'should write a file but agent crashes before',
          validation: { command: 'true', 'must-pass': true },
          // retries: 0 so the test sees the first-attempt failure
          retries: 0,
        },
      ],
    });

    // Agent exits without writing anything — simulates copilot's
    // "Invalid command format" instant-crash, or any CLI that bails before
    // touching files.
    const backend = new FakeBackend({ events: [], exitCode: 1 });

    const failures: { msg: string }[] = [];
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => backend,
      onProgress: (ev) => {
        if (ev.type === 'task:failed') failures.push({ msg: ev.error.message });
      },
    });
    expect(result.status).toBe('failed');
    expect(failures[0]?.msg).toMatch(/produced no new work/);
  });

  it('does NOT fire when the agent legitimately writes a file', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: ew\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'ew' },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'write a file',
          validation: { command: 'true', 'must-pass': true },
        },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'made.txt'), 'hi');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r2',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');
  });
});
