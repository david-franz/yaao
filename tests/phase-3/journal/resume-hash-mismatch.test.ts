import { describe, it, expect, afterEach } from 'vitest';
import { openJournal, loadRun, hashPlan } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('plan hash for resume', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('hashPlan is stable for identical input and changes for any edit', () => {
    const a = 'plan: { name: a, version: 1 }';
    const b = 'plan: { name: a, version: 1 } # edit';
    expect(hashPlan(a)).toBe(hashPlan(a));
    expect(hashPlan(a)).not.toBe(hashPlan(b));
  });

  it('the journal records planHash so resume callers can detect drift', async () => {
    project = createTmpProject();
    const j = await openJournal('r1', { dir: project.path });
    const planHash = hashPlan('plan-content-v1');
    await j.append({
      t: 'run:start',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      planFile: 'plan.yaml',
      planHash,
      config: { baseBranch: 'main', maxParallel: 4 },
    });
    await j.close();
    const { summary } = await loadRun('r1', project.path);
    expect(summary.planHash).toBe(planHash);
  });
});
