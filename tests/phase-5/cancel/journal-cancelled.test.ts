import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCancelToJournal } from '../../../src/exec/cancel-journal.js';
import { loadRun } from '../../../src/git/journal.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('appendCancelToJournal — Ctrl-C must flip the run status off "running"', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('appends a run:end cancelled line and the summary derivation picks it up', async () => {
    project = createTmpProject();
    const runId = 'cx1';
    const runsDir = join(project.path, '.yaao', 'runs');
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    // Simulate a journal that captured run:start + a couple of task events
    // but never got run:end (the runner was killed mid-flight).
    const lines = [
      JSON.stringify({ t: 'run:start', time: '2026-05-20T12:00:00.000Z', runId, planFile: '/x', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } }),
      JSON.stringify({ t: 'task:queued', time: '2026-05-20T12:00:01.000Z', taskId: 't1', depends: [] }),
      JSON.stringify({ t: 'task:running', time: '2026-05-20T12:00:02.000Z', taskId: 't1', agent: 'claude-code', worktree: '/w', branch: 'b', pid: 1 }),
    ];
    writeFileSync(join(runDir, 'journal.jsonl'), lines.join('\n') + '\n');

    // Before the cancel append, status is still 'running' (default).
    const before = await loadRun(runId, runsDir);
    expect(before.summary.status).toBe('running');

    appendCancelToJournal({ cwd: project.path, runId, durationMs: 1500 });

    // After the cancel append, status derives to 'cancelled' and the
    // raw journal carries the new event.
    const after = await loadRun(runId, runsDir);
    expect(after.summary.status).toBe('cancelled');
    const raw = readFileSync(join(runDir, 'journal.jsonl'), 'utf8');
    const last = raw.trim().split('\n').pop()!;
    const parsed = JSON.parse(last) as { t: string; status: string; durationMs: number };
    expect(parsed.t).toBe('run:end');
    expect(parsed.status).toBe('cancelled');
    expect(parsed.durationMs).toBe(1500);
  });

  it('is a no-op when the journal file does not exist (e.g. signal hit before runPlan opened it)', () => {
    project = createTmpProject();
    // Calling without ever creating the journal directory must not throw.
    expect(() => appendCancelToJournal({ cwd: project.path, runId: 'never-started' })).not.toThrow();
  });
});
