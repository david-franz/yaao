import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yaaoResumeTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, SpawnOptions } from '../../../src/agents/backend.js';
import { loadRun } from '../../../src/git/journal.js';

// Prompts in the on-disk YAML must match the prompts in fakeResolved below —
// the worktree cache key includes a hash of the resolved prompt body, so a
// mismatch between the in-memory plan used for the first run and the on-disk
// plan that yaao_resume reloads would force a fresh worktree (which then
// collides with the existing path).
const PLAN_YAML = `plan:
  name: rsm
  version: 1
config:
  merge:
    strategy: auto
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: p
    validation:
      command: test -f a.txt
      must-pass: true
  - id: b
    title: B
    agent: claude-code
    prompt: p
    depends: [a]
    validation:
      command: test -f b.txt
      must-pass: true
`;

// Backend factory: succeeds for `succeed` tasks, fails (writes nothing,
// causes empty-work guard) for `fail` tasks. `failingIds` is the set whose
// invocation should fail on the first attempt.
function selectiveBackend(failingIds: Set<string>): AgentBackend {
  const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'spawn') {
        return async (opts: SpawnOptions) => {
          // Encode task id in the worktree path: <wtRoot>/<runId>/<taskId>
          const taskId = opts.cwd.split('/').pop() ?? '';
          if (!failingIds.has(taskId)) {
            writeFileSync(join(opts.cwd, `${taskId}.txt`), `work for ${taskId}\n`);
          }
          // Failing tasks: don't write anything; the empty-work guard will
          // fail the task before merge.
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('yaao_resume MCP tool', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('continues a failed prior run under the same runId and lands the failed task', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    repo.commit('plan');

    const { plan } = fakeResolved({
      plan: { name: 'rsm' },
      config: { merge: { strategy: 'auto' as const } },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'p',
          validation: { command: 'test -f a.txt', 'must-pass': true },
        },
        {
          id: 'b',
          title: 'B',
          agent: 'claude-code',
          prompt: 'p',
          depends: ['a'],
          validation: { command: 'test -f b.txt', 'must-pass': true },
        },
      ],
    });
    // First run: task `a` produces no work → fails. `b` is cascade-skipped.
    const first = await runPlan({
      runId: 'rsm-1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => selectiveBackend(new Set(['a'])),
    });
    expect(first.status).toBe('failed');
    {
      const { summary } = await loadRun('rsm-1', join(repo.path, '.yaao', 'runs'));
      expect(summary.tasks['a']?.status).toBe('failed');
      expect(summary.tasks['b']?.status).toBe('skipped');
    }

    // Resume: now a writes its file, b can run, both should land.
    const ctx: ToolContext = {
      cwd: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => selectiveBackend(new Set()),
    };
    const r = await yaaoResumeTool({ runId: 'rsm-1' }, ctx);
    expect(r.structuredContent['ok']).toBe(true);
    expect(r.structuredContent['runId']).toBe('rsm-1');
    expect(r.structuredContent['resumed']).toBe(true);

    // Same runId → same journal. Final state of the same summary is
    // both-completed, both-merged.
    const { summary } = await loadRun('rsm-1', join(repo.path, '.yaao', 'runs'));
    expect(summary.tasks['a']?.status).toBe('completed');
    expect(summary.tasks['b']?.status).toBe('completed');
    expect(summary.tasks['a']?.mergeStatus).toBe('merged');
    expect(summary.tasks['b']?.mergeStatus).toBe('merged');
  });

  it('reskip: true leaves previously-skipped tasks skipped on the resume', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, PLAN_YAML);
    repo.commit('plan');

    const { plan } = fakeResolved({
      plan: { name: 'rsm' },
      config: { merge: { strategy: 'auto' as const } },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'p',
          validation: { command: 'test -f a.txt', 'must-pass': true },
        },
        {
          id: 'b',
          title: 'B',
          agent: 'claude-code',
          prompt: 'p',
          depends: ['a'],
          validation: { command: 'test -f b.txt', 'must-pass': true },
        },
      ],
    });
    await runPlan({
      runId: 'rsm-2',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => selectiveBackend(new Set(['a'])),
    });
    const ctx: ToolContext = {
      cwd: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => selectiveBackend(new Set()),
    };
    await yaaoResumeTool({ runId: 'rsm-2', reskip: true }, ctx);
    const { summary } = await loadRun('rsm-2', join(repo.path, '.yaao', 'runs'));
    // `a` re-ran (it was failed, not skipped, and retryFailed defaults true).
    expect(summary.tasks['a']?.status).toBe('completed');
    // `b` was skipped previously; reskip: true filters it out of the resume.
    expect(summary.tasks['b']?.status).toBe('skipped');
  });

  it('reports a clear error for an unknown runId', async () => {
    repo = createTestRepo();
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoResumeTool({ runId: 'does-not-exist' }, ctx);
    expect(r.structuredContent['ok']).toBe(false);
    const errs = r.structuredContent['errors'] as { code: string; message: string }[];
    expect(errs[0]?.code).toBe('YAAO_RESUME_NO_PLAN');
  });
});
