import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('yaao run --resume on interrupted (running) tasks', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('reuses the existing worktree instead of failing on path collision', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rr\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rr' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const config = (await import('../../../src/config/types.js')).DEFAULT_CONFIG;

    // Hand-craft a journal showing task `a` as still running (Ctrl-C'd).
    const runDir = join(cwd, '.yaao', 'runs', 'rr');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'journal.jsonl'),
      [
        JSON.stringify({
          t: 'run:start',
          time: '2026-01-01T00:00:00Z',
          runId: 'rr',
          planFile,
          planHash: 'h',
          config: { baseBranch: 'main', maxParallel: 1 },
        }),
        JSON.stringify({ t: 'task:queued', time: '2026-01-01T00:00:01Z', taskId: 'a', depends: [] }),
        JSON.stringify({ t: 'task:ready', time: '2026-01-01T00:00:02Z', taskId: 'a' }),
        JSON.stringify({
          t: 'task:running',
          time: '2026-01-01T00:00:03Z',
          taskId: 'a',
          agent: 'claude-code',
          worktree: join(cwd, '.yaao', 'worktrees', 'rr', 'a'),
          branch: 'rr/a',
          pid: 0,
        }),
      ].join('\n') + '\n',
    );
    // Pre-create the worktree to simulate the leftover state from the interrupted run.
    execaSync('git', ['branch', 'rr/a', 'main'], { cwd });
    execaSync('git', ['worktree', 'add', join(cwd, '.yaao', 'worktrees', 'rr', 'a'), 'rr/a'], { cwd });
    const yaaoStampDir = join(cwd, '.yaao', 'worktrees', 'rr', 'a', '.yaao');
    mkdirSync(yaaoStampDir, { recursive: true });
    writeFileSync(
      join(yaaoStampDir, '.task'),
      JSON.stringify({
        runId: 'rr',
        taskId: 'a',
        branch: 'rr/a',
        baseCommit: execaSync('git', ['rev-parse', 'HEAD'], { cwd }).stdout.trim(),
      }),
    );

    // On resume, the task should be re-launched on the existing worktree.
    let spawned = 0;
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            spawned += 1;
            // The spawn cwd MUST be the existing worktree path.
            expect(opts.cwd).toBe(join(cwd, '.yaao', 'worktrees', 'rr', 'a'));
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rr',
      plan,
      planFile,
      rootDir: cwd,
      config,
      backendFor: () => wrap,
      resume: true,
    });

    expect(result.status).toBe('success');
    expect(spawned).toBe(1);
    expect(existsSync(join(cwd, '.yaao', 'worktrees', 'rr', 'a'))).toBe(true);
  });
});
