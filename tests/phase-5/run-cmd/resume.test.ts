import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('yaao run --resume', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('re-runs only the failed tasks and injects prior failure context', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rs\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rs' },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'write a',
        },
        {
          id: 'b',
          title: 'B',
          agent: 'claude-code',
          depends: ['a'],
          prompt: 'pass after fix',
          // Pin retries to 0 so the first run fails immediately and the test
          // exercises the --resume path, not in-run retry.
          retries: 0,
          validation: { command: 'test -f marker.txt', 'must-pass': true },
        },
      ],
    });

    // First run: a succeeds, b fails its validation.
    //
    // Task discrimination via prompt content is now ambiguous: F16.3
    // propagates the parent's `## Original task` (its raw prompt) into
    // each dependent's resolved prompt, so task b's prompt also
    // contains task a's "write a" string. We discriminate on task b's
    // own marker `pass after fix` instead — it only appears in b's
    // resolved prompt.
    let firstRunPromptForB = '';
    const aWritesFile = new Proxy(new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }), {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // task a writes some artifact; b records its prompt but does NOT write marker.
            if (opts.prompt.includes('pass after fix')) {
              firstRunPromptForB = opts.prompt;
            } else {
              writeFileSync(join(opts.cwd, 'a.txt'), 'hello');
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const r1 = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rresume',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => aWritesFile,
    });
    expect(r1.status).toBe('failed');
    expect(firstRunPromptForB).not.toMatch(/Previous attempt failed/);

    // Resume: a should be skipped (already completed), b should retry with the
    // prior-failure prefix injected into its prompt. The second-attempt agent
    // writes the marker so validation passes.
    let resumedPromptForB = '';
    let aSpawnsOnResume = 0;
    const fixesIt = new Proxy(new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }), {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // Same discrimination caveat as the first run — match on
            // task b's own prompt marker (`pass after fix`) since the
            // F16.3 dep-context preamble now inlines task a's
            // original prompt into task b's prompt too.
            if (opts.prompt.includes('pass after fix')) {
              resumedPromptForB = opts.prompt;
              writeFileSync(join(opts.cwd, 'marker.txt'), 'ok');
            } else {
              aSpawnsOnResume += 1;
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const r2 = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rresume',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => fixesIt,
      resume: true,
    });

    expect(r2.status).toBe('success');
    expect(aSpawnsOnResume).toBe(0); // a was not re-run
    expect(resumedPromptForB).toMatch(/Previous attempt failed/);
    expect(resumedPromptForB).toMatch(/test -f marker\.txt/);
  });
});
