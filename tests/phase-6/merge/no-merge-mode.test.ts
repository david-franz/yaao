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
  name: nm
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

describe('yaao run --no-merge', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('completes the task but leaves base-branch untouched and the task branch intact', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    repo.commit('plan');
    const baseShaBefore = repo.run(['rev-parse', 'main']).stdout.trim();

    const { plan } = fakeResolved({
      plan: { name: 'nm' },
      config: { merge: { strategy: 'auto' as const } },
      tasks: [{ id: 't', title: 'T', agent: 'claude-code', prompt: 'p' }],
    });
    const r = await runPlan({
      runId: 'nm1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      noMerge: true,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');

    // Base branch hasn't moved.
    const baseShaAfter = repo.run(['rev-parse', 'main']).stdout.trim();
    expect(baseShaAfter).toBe(baseShaBefore);

    // Task summary captures the branch + commit so the caller can PR/merge themselves.
    const { summary } = await loadRun('nm1', join(repo.path, '.yaao', 'runs'));
    const t = summary.tasks['t'];
    expect(t?.status).toBe('completed');
    expect(t?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(t?.branch).toMatch(/^nm\/t$/);
    // No merge happened, so no mergeStatus is recorded.
    expect(t?.mergeStatus).toBeUndefined();
  });
});
