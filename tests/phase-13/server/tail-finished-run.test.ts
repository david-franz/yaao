import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tailJournal } from '../../../src/web/journal-tail.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('tailJournal — finished runs', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('replays every event from a journal that ends with run:end (regression: drain-before-closed)', async () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    // Hand-roll a complete journal: start, two task lifecycles, end. The
    // bug: tailJournal saw run:end during the initial readNew, called
    // finish() synchronously, set closed=true — and then the consumer
    // loop's `while (!closed)` exit fired before any queued events were
    // yielded. SSE responses streamed zero data lines, the web viewer
    // showed "lost connection" with nothing to display. This test pins
    // the fix.
    const lines = [
      { t: 'run:start', time: '2026-05-20T12:00:00.000Z', runId: 'r1', planFile: '/x', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
      { t: 'task:queued', time: '2026-05-20T12:00:01.000Z', taskId: 'a', depends: [] },
      { t: 'task:running', time: '2026-05-20T12:00:02.000Z', taskId: 'a', agent: 'claude-code', worktree: '/w', branch: 'b', pid: 1 },
      { t: 'task:completed', time: '2026-05-20T12:00:03.000Z', taskId: 'a', durationMs: 1000, filesChanged: 1, commit: 'a'.repeat(40) },
      { t: 'run:end', time: '2026-05-20T12:00:04.000Z', status: 'success', durationMs: 4000 },
    ];
    writeFileSync(join(runDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const ac = new AbortController();
    const got: { id: number; t: string }[] = [];
    for await (const rec of tailJournal({ journalPath: join(runDir, 'journal.jsonl'), signal: ac.signal })) {
      got.push({ id: rec.id, t: rec.event.t });
    }
    expect(got.map((g) => g.t)).toEqual([
      'run:start',
      'task:queued',
      'task:running',
      'task:completed',
      'run:end',
    ]);
    expect(got.map((g) => g.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('honours Last-Event-ID: a client reconnecting after event 3 only gets events 4..end', async () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r2');
    mkdirSync(runDir, { recursive: true });
    const lines = [
      { t: 'run:start', time: '2026-05-20T12:00:00.000Z', runId: 'r2', planFile: '/x', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } },
      { t: 'task:queued', time: '2026-05-20T12:00:01.000Z', taskId: 'a', depends: [] },
      { t: 'task:running', time: '2026-05-20T12:00:02.000Z', taskId: 'a', agent: 'claude-code', worktree: '/w', branch: 'b', pid: 1 },
      { t: 'task:completed', time: '2026-05-20T12:00:03.000Z', taskId: 'a', durationMs: 1000, filesChanged: 1, commit: 'a'.repeat(40) },
      { t: 'run:end', time: '2026-05-20T12:00:04.000Z', status: 'success', durationMs: 4000 },
    ];
    writeFileSync(join(runDir, 'journal.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const ac = new AbortController();
    const got: number[] = [];
    for await (const rec of tailJournal({ journalPath: join(runDir, 'journal.jsonl'), signal: ac.signal, lastEventId: 3 })) {
      got.push(rec.id);
    }
    expect(got).toEqual([4, 5]);
  });
});
