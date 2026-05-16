import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('yaao run --resume (idempotent)', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('a second resume sees the first resume\'s synthesised completions', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rt\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rt' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', depends: ['a'], prompt: 'p' },
      ],
    });
    const config = (await import('../../../src/config/types.js')).DEFAULT_CONFIG;

    // First run: a completes, b fails its validation.
    const failingValidation = new Proxy(new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }), {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // a writes a file; b does nothing (validation will fail).
            if (opts.prompt.includes('A') || opts.cwd.endsWith('/a')) {
              writeFileSync(join(opts.cwd, 'a.txt'), 'hi');
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    // Inject a failing validation on b via a wrapped plan.
    plan.tasks[1]!.validation = { command: 'test -f marker.txt', 'must-pass': true };
    const r1 = await runPlan({
      runId: 'rt',
      plan,
      planFile,
      rootDir: repo.path,
      config,
      backendFor: () => failingValidation,
    });
    expect(r1.status).toBe('failed');

    // First resume: a is synthesised completed, b retries and now succeeds.
    let bSpawnsOnFirstResume = 0;
    const fixed = new Proxy(new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }), {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            if (opts.cwd.endsWith('/b')) {
              bSpawnsOnFirstResume += 1;
              writeFileSync(join(opts.cwd, 'marker.txt'), 'ok');
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const r2 = await runPlan({
      runId: 'rt',
      plan,
      planFile,
      rootDir: repo.path,
      config,
      backendFor: () => fixed,
      resume: true,
    });
    expect(r2.status).toBe('success');
    expect(bSpawnsOnFirstResume).toBe(1); // b ran exactly once on this resume

    // Sanity check: synthesised completions ARE in the journal after this run.
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'rt', 'journal.jsonl'))).toBe(true);

    // Second resume: both a and b should be synthesised — neither agent should spawn.
    let anySpawn = 0;
    const shouldNotSpawn = new Proxy(new FakeBackend({ events: [] }), {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            anySpawn += 1;
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const r3 = await runPlan({
      runId: 'rt',
      plan,
      planFile,
      rootDir: repo.path,
      config,
      backendFor: () => shouldNotSpawn,
      resume: true,
    });
    expect(r3.status).toBe('success');
    expect(anySpawn).toBe(0);
  });
});
