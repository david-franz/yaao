import { describe, it, expect, afterEach } from 'vitest';
import { openJournal, loadRun } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('Journal append + replay', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes events and replays them in order', async () => {
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
    await j.append({ t: 'task:ready', time: '2026-01-01T00:00:02Z', taskId: 'a' });
    await j.close();
    const { events, summary } = await loadRun('r1', project.path);
    expect(events).toHaveLength(3);
    expect(summary.runId).toBe('r1');
    expect(summary.tasks['a']?.status).toBe('ready');
  });
});
