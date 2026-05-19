import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend } from '../../../src/agents/backend.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { loadRun } from '../../../src/git/journal.js';

const PLAN_YAML = `plan:
  name: gate
  version: 1
tasks:
  - id: t
    title: T
    agent: claude-code
    prompt: write a.txt
`;

function writingBackend(): AgentBackend {
  const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'spawn') {
        return async (opts: Parameters<typeof inner.spawn>[0]) => {
          writeFileSync(join(opts.cwd, 'a.txt'), 'a\n');
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('yaao run plan-tracking gate', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('refuses to start when the plan file is not tracked', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    const { plan } = fakeResolved({
      plan: { name: 'gate' },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    await expect(
      runPlan({
        runId: 'g1',
        plan,
        planFile,
        rootDir: repo.path,
        config: DEFAULT_CONFIG,
        backendFor: () => writingBackend(),
      }),
    ).rejects.toMatchObject({ code: 'YAAO_PLAN_UNTRACKED' });
  });

  it('records planCommit / planBlob in the journal when the plan is tracked', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    const planSha = repo.commit('add plan');
    const { plan } = fakeResolved({
      plan: { name: 'gate' },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    const r = await runPlan({
      runId: 'g2',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');
    const { summary } = await loadRun('g2', join(repo.path, '.yaao', 'runs'));
    expect(summary.planCommit).toBe(planSha);
    expect(summary.planBlob).toMatch(/^[0-9a-f]{40}$/);
  });

  it('--commit-plan auto-commits the plan and anchors the run', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    const { plan } = fakeResolved({
      plan: { name: 'gate' },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    const r = await runPlan({
      runId: 'g3',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      commitPlan: true,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');
    const { summary } = await loadRun('g3', join(repo.path, '.yaao', 'runs'));
    expect(summary.planCommit).toMatch(/^[0-9a-f]{40}$/);
    // The plan-commit subject mentions the plan name and runId. Look it up
    // directly so the assertion isn't sensitive to whatever the run merged
    // on top.
    const subj = repo.run(['log', '-1', '--format=%s', summary.planCommit!]);
    expect(subj.stdout).toContain('[yaao] plan gate');
    expect(subj.stdout).toContain('g3');
  });

  it('warn mode lets an untracked plan through without recording an anchor', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    const { plan } = fakeResolved({
      plan: { name: 'gate' },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    const r = await runPlan({
      runId: 'g4',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      requireTrackedPlan: 'warn',
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');
    const { summary } = await loadRun('g4', join(repo.path, '.yaao', 'runs'));
    expect(summary.planCommit).toBeUndefined();
  });
});
