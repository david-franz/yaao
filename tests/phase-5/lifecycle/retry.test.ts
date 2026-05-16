import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { RunEvent } from '../../../src/exec/bus.js';

describe('automatic retries', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('re-runs a failing task up to `retries` times with failure context in the prompt', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rp' },
      tasks: [
        {
          id: 'flaky',
          title: 'Flaky',
          agent: 'claude-code',
          prompt: 'write a file then validation will fail twice then pass',
          retries: 2,
          validation: { command: 'test -f marker.txt', 'must-pass': true },
        },
      ],
    });

    let attempt = 0;
    const prompts: string[] = [];
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const flakyBackend = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            attempt += 1;
            prompts.push(opts.prompt);
            // Third attempt writes the marker the validation looks for.
            if (attempt >= 3) {
              writeFileSync(join(opts.cwd, 'marker.txt'), 'ok');
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const events: RunEvent[] = [];
    const result = await runPlan({
      runId: 'rretry',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => flakyBackend,
      onProgress: (ev) => events.push(ev),
    });

    expect(result.status).toBe('success');
    expect(attempt).toBe(3);
    // Attempt 2 and 3 must include the prior-failure context.
    expect(prompts[1]).toMatch(/Previous attempt failed/);
    expect(prompts[1]).toMatch(/test -f marker\.txt/);
    expect(prompts[2]).toMatch(/Previous attempt failed/);
    // Retry events fired twice.
    const retryEvents = events.filter((e) => e.type === 'task:retry-attempt');
    expect(retryEvents).toHaveLength(2);
  });

  it('after exhausting retries, reports task:failed with the captured tail', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rp' },
      tasks: [
        {
          id: 'always-fail',
          title: 'Always fail',
          agent: 'claude-code',
          prompt: 'p',
          retries: 1,
          validation: { command: 'false', 'must-pass': true },
        },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });

    const failures: { msg: string; stderrTail?: string }[] = [];
    const result = await runPlan({
      runId: 'rfail',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => backend,
      onProgress: (ev) => {
        if (ev.type === 'task:failed') {
          const err = ev.error as unknown as { stderrTail?: string };
          failures.push({ msg: ev.error.message, ...(err.stderrTail !== undefined ? { stderrTail: err.stderrTail } : {}) });
        }
      },
    });
    expect(result.status).toBe('failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.msg).toMatch(/exited 1/);
  });
});
