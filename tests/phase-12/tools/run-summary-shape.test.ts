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
  name: rs
  version: 1
config:
  merge:
    strategy: auto
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
          writeFileSync(join(opts.cwd, 'a.txt'), 'hi\n');
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('RunSummary surfaces per-task filesChanged / commit / mergeCommit', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('persists task commit, filesChanged, and merge SHA in the journal summary', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    repo.commit('plan');
    const { plan } = fakeResolved({
      plan: { name: 'rs' },
      config: { merge: { strategy: 'auto' as const } },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    const r = await runPlan({
      runId: 'rs1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');
    const { summary } = await loadRun('rs1', join(repo.path, '.yaao', 'runs'));
    const t = summary.tasks['t'];
    expect(t).toBeDefined();
    expect(t?.filesChanged).toBeGreaterThan(0);
    expect(t?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(t?.mergeStatus).toBe('merged');
    expect(t?.mergeInto).toBe('main');
    expect(t?.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('flags worktree reuse with cachedFromRunId pointing at the original run', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    repo.commit('plan');
    const { plan } = fakeResolved({
      plan: { name: 'rs' },
      config: { merge: { strategy: 'manual' as const } },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    // First run leaves a worktree (no merge, manual strategy keeps the branch + worktree).
    await runPlan({
      runId: 'rs-first',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => writingBackend(),
    });
    // Second run with a different runId reuses the stamped worktree.
    await runPlan({
      runId: 'rs-second',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => writingBackend(),
    });
    const { summary } = await loadRun('rs-second', join(repo.path, '.yaao', 'runs'));
    expect(summary.tasks['t']?.cachedFromRunId).toBe('rs-first');
  });
});
