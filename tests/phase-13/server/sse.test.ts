import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWebServer, type WebServerHandle } from '../../../src/web/server.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { ToolContext } from '../../../src/mcp/tools.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { openJournal } from '../../../src/git/journal.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDist = join(here, '..', 'scaffold', 'fixture-dist');

function ctxFor(repoPath: string): ToolContext {
  return { cwd: repoPath, config: DEFAULT_CONFIG };
}

async function start(repoPath: string): Promise<WebServerHandle> {
  return startWebServer({
    cwd: repoPath,
    port: 0,
    distDir: fixtureDist,
    ctxOverride: ctxFor(repoPath),
  });
}

/**
 * Read SSE frames from a Response body until the predicate returns true OR
 * the timeout fires. Returns the frames collected.
 */
async function collectSse(
  resp: Response,
  predicate: (frames: SseFrame[]) => boolean,
  timeoutMs = 3_000,
): Promise<SseFrame[]> {
  if (!resp.body) throw new Error('no response body');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buf = '';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((res) =>
        setTimeout(() => res({ value: undefined, done: true }), timeoutMs - (Date.now() - start)),
      ),
    ]);
    if (done || !value) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const frame = parseFrame(block);
      if (frame) frames.push(frame);
      sep = buf.indexOf('\n\n');
    }
    if (predicate(frames)) break;
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

function parseFrame(block: string): SseFrame | undefined {
  if (block.startsWith(':')) return undefined; // keepalive comment
  const frame: SseFrame = { data: '' };
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data += line.slice(6);
  }
  return frame;
}

describe('F13.1 SSE endpoints', () => {
  let handle: WebServerHandle | undefined;
  let repo: TestRepo | undefined;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    repo?.cleanup();
    repo = undefined;
  });

  it('/api/plans/:slug/watch fires when the plan file changes on disk', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    writeFileSync(
      join(repo.path, '.yaao', 'exec', 'p.yaml'),
      'plan:\n  name: p\n  version: 1\ntasks: []\n',
    );
    handle = await start(repo.path);
    const resp = await fetch(`http://${handle.host}:${handle.port}/api/plans/p/watch`);
    expect(resp.status).toBe(200);
    // Give the fs.watch a moment to prime.
    setTimeout(() => {
      writeFileSync(
        join(repo!.path, '.yaao', 'exec', 'p.yaml'),
        'plan:\n  name: p\n  version: 2\ntasks: []\n',
      );
    }, 200);
    const frames = await collectSse(resp, (f) => f.length >= 1, 3000);
    expect(frames[0]?.event).toBe('change');
  });

  it('/api/runs/:runId/events replays journaled events then live-tails', async () => {
    repo = createTestRepo();
    const journalDir = join(repo.path, '.yaao', 'runs');
    const journal = await openJournal('r1', { dir: journalDir });
    // Pre-existing events the SSE consumer should replay.
    await journal.append({
      t: 'run:start',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      planFile: '/x',
      planHash: 'h',
      config: { baseBranch: 'main', maxParallel: 1 },
    });
    await journal.append({ t: 'task:queued', time: '2026-01-01T00:00:01Z', taskId: 't', depends: [] });

    handle = await start(repo.path);
    const resp = await fetch(`http://${handle.host}:${handle.port}/api/runs/r1/events`);
    expect(resp.status).toBe(200);

    // Append one more event after the SSE subscriber is attached; expect 3 frames.
    setTimeout(() => {
      void journal.append({
        t: 'task:ready',
        time: '2026-01-01T00:00:02Z',
        taskId: 't',
      });
    }, 300);

    const frames = await collectSse(resp, (f) => f.length >= 3, 3000);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    // Each frame carries a numeric id (line number) and an `event` field
    // == the journal record's `t`.
    expect(frames[0]?.event).toBe('run:start');
    expect(Number(frames[0]?.id)).toBe(1);
    expect(frames[1]?.event).toBe('task:queued');
    expect(frames[2]?.event).toBe('task:ready');
    await journal.close();
  });

  it('Last-Event-ID resumes the journal after the given line', async () => {
    repo = createTestRepo();
    const journalDir = join(repo.path, '.yaao', 'runs');
    const journal = await openJournal('r1', { dir: journalDir });
    await journal.append({
      t: 'run:start',
      time: '2026-01-01T00:00:00Z',
      runId: 'r1',
      planFile: '/x',
      planHash: 'h',
      config: { baseBranch: 'main', maxParallel: 1 },
    });
    await journal.append({ t: 'task:queued', time: '2026-01-01T00:00:01Z', taskId: 't', depends: [] });
    await journal.append({ t: 'task:ready', time: '2026-01-01T00:00:02Z', taskId: 't' });
    await journal.close();

    handle = await start(repo.path);
    // Resume after line 1 (the run:start event).
    const resp = await fetch(`http://${handle.host}:${handle.port}/api/runs/r1/events`, {
      headers: { 'last-event-id': '1' },
    });
    const frames = await collectSse(resp, (f) => f.length >= 2, 2000);
    // Should only replay lines 2 and 3 (queued + ready), not run:start.
    expect(frames.map((f) => f.event)).toEqual(['task:queued', 'task:ready']);
    expect(Number(frames[0]?.id)).toBe(2);
  });
});
