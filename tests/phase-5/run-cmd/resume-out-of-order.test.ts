import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('yaao run --resume with non-topological priorSummary order', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  /**
   * In real runs the journal's task-event order isn't topological — cascade
   * skips and parallel-arrival ordering can land downstream tasks in the
   * Record before their deps. The resume synthesis used to call
   * scheduler.startTask in iteration order; on a downstream task it threw
   * (status='pending'), the try/catch swallowed the error, and the whole
   * synthesis pass bailed leaving the rest of the run to re-spawn tasks
   * that were already done. Regression test: synthesise every completed
   * task regardless of iteration order.
   */
  it('synthesises every completed task even when priorSummary order is not topological', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: oo\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'oo' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', depends: ['a'], prompt: 'p' },
        { id: 'c', title: 'C', agent: 'claude-code', depends: ['b'], prompt: 'p' },
      ],
    });
    const config = (await import('../../../src/config/types.js')).DEFAULT_CONFIG;

    // Hand-craft a journal whose task-event insertion order is reversed:
    // c (the leaf) appears before b and a. All three are completed.
    const runDir = join(cwd, '.yaao', 'runs', 'oo');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'journal.jsonl'),
      [
        // run:start first
        { t: 'run:start', time: 't0', runId: 'oo', planFile, planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
        // task:queued events arrive in the WRONG topological order (c, b, a).
        { t: 'task:queued', time: 't1', taskId: 'c', depends: ['b'] },
        { t: 'task:queued', time: 't1', taskId: 'b', depends: ['a'] },
        { t: 'task:queued', time: 't1', taskId: 'a', depends: [] },
        // All three completed at some point in a prior run.
        { t: 'task:completed', time: 't2', taskId: 'a', durationMs: 1, filesChanged: 0, commit: 'a' },
        { t: 'task:completed', time: 't3', taskId: 'b', durationMs: 1, filesChanged: 0, commit: 'b' },
        { t: 'task:completed', time: 't4', taskId: 'c', durationMs: 1, filesChanged: 0, commit: 'c' },
        { t: 'run:end', time: 't5', status: 'success', durationMs: 4 },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );

    // No spawn should fire — all three are already completed.
    let spawned = 0;
    const backend = new FakeBackend({ events: [] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            spawned += 1;
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'oo',
      plan,
      planFile,
      rootDir: cwd,
      config,
      backendFor: () => wrap,
      resume: true,
    });

    expect(result.status).toBe('success');
    expect(spawned).toBe(0);
  });
});
