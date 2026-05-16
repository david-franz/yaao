import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRun } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('Journal replay — task:completed is sticky', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  /**
   * A real journal we observed: a task succeeded in one run, then a later run
   * hit a worktree-collision bug that recorded `task:failed` for the same id,
   * then yet another run tried again. The replay needs to recognise that the
   * task already completed and ignore the noise from the broken intervening
   * runs — otherwise resume re-runs work that's already done.
   */
  it('ignores later transient state events for a task that completed earlier', async () => {
    project = createTmpProject();
    const runDir = join(project.path, 'r');
    mkdirSync(runDir, { recursive: true });

    const lines = [
      { t: 'run:start', time: 't0', runId: 'r', planFile: 'p.yaml', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
      { t: 'task:queued', time: 't1', taskId: 'a', depends: [] },
      { t: 'task:ready', time: 't2', taskId: 'a' },
      { t: 'task:running', time: 't3', taskId: 'a', agent: 'claude-code', worktree: '/wt/a', branch: 'p/a', pid: 0 },
      { t: 'task:failed', time: 't4', taskId: 'a', durationMs: 100, error: { code: 'X', message: 'original failure' } },
      { t: 'run:end', time: 't5', status: 'failed', durationMs: 500 },
      // Second run: task actually succeeded.
      { t: 'run:start', time: 't6', runId: 'r', planFile: 'p.yaml', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
      { t: 'task:running', time: 't7', taskId: 'a', agent: 'claude-code', worktree: '/wt/a', branch: 'p/a', pid: 0 },
      { t: 'task:completed', time: 't8', taskId: 'a', durationMs: 200, filesChanged: 3, commit: 'abc1234' },
      { t: 'run:end', time: 't9', status: 'success', durationMs: 300 },
      // Third run: a yaao bug accidentally re-ran the task and wrote task:failed.
      { t: 'run:start', time: 't10', runId: 'r', planFile: 'p.yaml', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
      { t: 'task:ready', time: 't11', taskId: 'a' },
      { t: 'task:failed', time: 't12', taskId: 'a', durationMs: 50, error: { code: 'Y', message: 'transient bug' } },
      { t: 'run:end', time: 't13', status: 'failed', durationMs: 100 },
    ];
    writeFileSync(join(runDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { summary } = await loadRun('r', project.path);
    expect(summary.tasks['a']?.status).toBe('completed');
  });
});
