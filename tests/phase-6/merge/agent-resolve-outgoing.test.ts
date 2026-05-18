import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('on-conflict=agent for outgoing merges', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  /**
   * The c-test failure mode: two sibling tasks both modify a shared file
   * (e.g. kernel.c). One auto-merges to main first; the second can't.
   * With on-conflict=agent the second's agent should be respawned in a
   * transient worktree to resolve the merge, then yaao advances main.
   */
  it('respawns the agent to resolve an outgoing conflict and lands the merge on the target', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: ar\n  version: 1\ntasks: []\n');

    // Set up a shared file on main that both task agents will edit.
    writeFileSync(join(cwd, 'shared.txt'), 'base\n');
    execaSync('git', ['add', 'shared.txt'], { cwd });
    execaSync('git', ['commit', '-m', 'base'], { cwd });

    const { plan } = fakeResolved({
      plan: { name: 'ar' },
      // Both run in parallel as siblings off the base commit.
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'edit shared as A' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'edit shared as B' },
      ],
    });

    // Spawn handler: during the initial task, agents write divergent
    // changes to the shared file. During the conflict-resolution call
    // (cwd points at a transient _outgoing-merge dir), the agent
    // resolves by combining both sides and commits.
    const spawnCalls: { cwd: string; prompt: string }[] = [];
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            spawnCalls.push({ cwd: opts.cwd, prompt: opts.prompt });
            const isResolution = opts.prompt.includes('Resolve an outgoing merge conflict');
            if (isResolution) {
              // Resolve by writing a deterministic combined value, then commit.
              // git add -A so any incidental unmerged paths (e.g. the
              // per-worktree .yaao/.task stamp) are also resolved.
              writeFileSync(join(opts.cwd, 'shared.txt'), 'combined-by-agent\n');
              execaSync('git', ['add', '-A'], { cwd: opts.cwd });
              execaSync('git', ['commit', '-m', 'resolved by agent'], {
                cwd: opts.cwd,
              });
            } else {
              // Initial task work: divergent content.
              const name = opts.cwd.split('/').pop();
              writeFileSync(join(opts.cwd, 'shared.txt'), `from-${name}\n`);
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rar',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // The shared file on main should have the agent's resolved content.
    const onMain = readFileSync(join(cwd, 'shared.txt'), 'utf8').trim();
    expect(onMain).toBe('combined-by-agent');

    // There should be a resolution spawn — at least one with the
    // outgoing-conflict prompt.
    const resolutionSpawns = spawnCalls.filter((c) =>
      c.prompt.includes('Resolve an outgoing merge conflict'),
    );
    expect(resolutionSpawns.length).toBeGreaterThan(0);
    expect(resolutionSpawns[0]?.cwd).toMatch(/_outgoing-merge/);

    // And the worktree should have been cleaned up.
    expect(existsSync(resolutionSpawns[0]!.cwd)).toBe(false);
  });
});
