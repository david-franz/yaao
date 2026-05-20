import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('runner journals task:queued with depends', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('every task has a task:queued line in the journal carrying its depends array', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: q\n  version: 1\ntasks: []\n');

    const { plan } = fakeResolved({
      plan: { name: 'q' },
      tasks: [
        { id: 'root', title: 'Root', agent: 'claude-code', prompt: 'p' },
        { id: 'child', title: 'Child', agent: 'claude-code', prompt: 'p', depends: ['root'] },
      ],
    });

    await runPlan({
      requireTrackedPlan: 'off',
      runId: 'q1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] }),
    });

    // The web viewer's TaskDag derives its dependency structure from
    // task:queued lines in the journal — without them, the live DAG view
    // falls back to a flat pill list. The scheduler emits these events
    // synchronously from its constructor, so the runner has to subscribe
    // the journal writer BEFORE constructing the scheduler. This test
    // pins that ordering — regression for "DAG renders as horizontal
    // pills no matter what."
    const journalPath = join(repo.path, '.yaao', 'runs', 'q1', 'journal.jsonl');
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    const queued = lines
      .map((l) => JSON.parse(l) as { t: string; taskId?: string; depends?: string[] })
      .filter((e) => e.t === 'task:queued');

    expect(queued.length).toBe(2);
    expect(queued.find((e) => e.taskId === 'root')?.depends).toEqual([]);
    expect(queued.find((e) => e.taskId === 'child')?.depends).toEqual(['root']);
  });
});
