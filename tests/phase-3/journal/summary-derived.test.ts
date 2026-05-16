import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openJournal } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('Journal summary sidecar', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes a summary.json after every event', async () => {
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
    await j.append({
      t: 'task:running',
      time: '2026-01-01T00:00:01Z',
      taskId: 'a',
      agent: 'claude-code',
      worktree: '/wt/a',
      branch: 'b/a',
      pid: 42,
    });
    await j.append({
      t: 'task:completed',
      time: '2026-01-01T00:00:05Z',
      taskId: 'a',
      durationMs: 4000,
      filesChanged: 2,
      commit: 'deadbeef',
    });
    await j.close();
    const summaryPath = join(project.path, 'r1', 'summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      tasks: Record<string, { status: string; agent?: string }>;
    };
    expect(summary.tasks['a']?.status).toBe('completed');
    expect(summary.tasks['a']?.agent).toBe('claude-code');
  });
});
