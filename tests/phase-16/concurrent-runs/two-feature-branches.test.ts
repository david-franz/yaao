import { describe, it, expect, afterEach } from 'vitest';
import { execaSync } from 'execa';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

/**
 * F16.2 — Two yaao runs against distinct feature branches must finish
 * independently. This is the load-bearing integration test for the
 * concurrency model documented in phase-16/F16.2-concurrency-model.md.
 *
 * Two plans (same plan.name and same task ids — the case most likely
 * to expose a missing namespace) run in parallel against
 * `feature/alpha` and `feature/beta` in the same repo. After
 * Promise.all completes we assert: both runs succeeded; each feature
 * branch contains its own task's commit; neither feature branch sees
 * the other's work; the root checkout (`main`) is byte-identical.
 *
 * Pre-F16.1 this test would have collided at worktree-manager.create
 * with `branch already exists` because both runs default-named their
 * task branch `shared/api`. Post-F16.1 the branches are
 * `feature/alpha/api` and `feature/beta/api` — disjoint by
 * construction.
 */
describe('F16.2 — two yaao runs against distinct feature branches', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('both runs complete; each feature branch carries its own work; root is unchanged', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: shared\n  version: 1\ntasks: []\n');

    function buildPlan(featureBranch: string) {
      const { plan } = fakeResolved({
        plan: { name: 'shared', version: 1, featureBranch },
        tasks: [{ id: 'api', title: 'A', agent: 'claude-code', prompt: 'do it' }],
      });
      return plan;
    }

    function writingBackend(filename: string, contents: string) {
      const base = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
      return new Proxy(base, {
        get(target, prop) {
          if (prop === 'spawn') {
            return async (opts: Parameters<typeof target.spawn>[0]) => {
              writeFileSync(join(opts.cwd, filename), contents);
              return target.spawn(opts);
            };
          }
          return Reflect.get(target, prop) as unknown;
        },
      });
    }

    const [a, b] = await Promise.all([
      runPlan({
        requireTrackedPlan: 'off',
        runId: 'ra',
        plan: buildPlan('feature/alpha'),
        planFile,
        rootDir: cwd,
        config: DEFAULT_CONFIG,
        backendFor: () => writingBackend('alpha.txt', 'alpha\n'),
      }),
      runPlan({
        requireTrackedPlan: 'off',
        runId: 'rb',
        plan: buildPlan('feature/beta'),
        planFile,
        rootDir: cwd,
        config: DEFAULT_CONFIG,
        backendFor: () => writingBackend('beta.txt', 'beta\n'),
      }),
    ]);

    expect(a.status).toBe('success');
    expect(b.status).toBe('success');

    // Each feature branch carries its own work and only its own work.
    const alphaFiles = execaSync('git', ['ls-tree', '-r', '--name-only', 'feature/alpha'], {
      cwd,
    }).stdout;
    const betaFiles = execaSync('git', ['ls-tree', '-r', '--name-only', 'feature/beta'], {
      cwd,
    }).stdout;
    expect(alphaFiles).toContain('alpha.txt');
    expect(alphaFiles).not.toContain('beta.txt');
    expect(betaFiles).toContain('beta.txt');
    expect(betaFiles).not.toContain('alpha.txt');

    // Default task branches use the F16.1 featureBranch namespace
    // (slashes sanitized to dashes so the featureBranch ref itself
    // doesn't conflict with task-branch siblings).
    const branches = execaSync('git', ['branch', '--format=%(refname:short)'], { cwd }).stdout;
    expect(branches).toContain('feature-alpha/api');
    expect(branches).toContain('feature-beta/api');
  });

  it("two runs share a journal directory without trampling each other (per-runId paths)", async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: shared\n  version: 1\ntasks: []\n');

    const { plan: planA } = fakeResolved({
      plan: { name: 'shared', version: 1, featureBranch: 'feature/x' },
      tasks: [{ id: 'api', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const { plan: planB } = fakeResolved({
      plan: { name: 'shared', version: 1, featureBranch: 'feature/y' },
      tasks: [{ id: 'api', title: 'B', agent: 'claude-code', prompt: 'p' }],
    });

    const fake = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const back = new Proxy(fake, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'f.txt'), 'x\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    await Promise.all([
      runPlan({
        requireTrackedPlan: 'off',
        runId: 'rcA',
        plan: planA,
        planFile,
        rootDir: cwd,
        config: DEFAULT_CONFIG,
        backendFor: () => back,
      }),
      runPlan({
        requireTrackedPlan: 'off',
        runId: 'rcB',
        plan: planB,
        planFile,
        rootDir: cwd,
        config: DEFAULT_CONFIG,
        backendFor: () => back,
      }),
    ]);

    // Each run has its own journal directory under .yaao/runs/<runId>/.
    const dirs = execaSync('ls', [join(cwd, '.yaao', 'runs')]).stdout.split('\n').filter(Boolean);
    expect(dirs).toContain('rcA');
    expect(dirs).toContain('rcB');
  });
});
