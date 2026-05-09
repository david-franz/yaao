import { describe, it, expect, afterEach } from 'vitest';
import { openJournal, loadRun } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('Journal crash recovery', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reconstructs accurate task statuses from a partially-written journal', async () => {
    project = createTmpProject();
    const j = await openJournal('r1', { dir: project.path });
    await j.append({
      t: 'run:start',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      planFile: 'plan.yaml',
      planHash: 'abc',
      config: { baseBranch: 'main', maxParallel: 4 },
    });
    await j.append({ t: 'task:queued', time: '2026-01-01T00:00:01Z', taskId: 'a', depends: [] });
    await j.append({
      t: 'task:running',
      time: '2026-01-01T00:00:02Z',
      taskId: 'a',
      agent: 'claude-code',
      worktree: '/wt/a',
      branch: 'b/a',
      pid: 42,
    });
    // simulated crash: never call close() or run:end
    const replay = await loadRun('r1', project.path);
    expect(replay.summary.status).toBe('running');
    expect(replay.summary.tasks['a']?.status).toBe('running');
    expect(replay.summary.tasks['a']?.agent).toBe('claude-code');
  });
});
