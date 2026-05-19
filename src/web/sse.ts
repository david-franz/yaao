/**
 * SSE primitives used across `yaao web` routes.
 *
 * Two patterns:
 *
 *   1. `streamEvents(c, source)` — wraps a hono context in a
 *      text/event-stream response and pumps an async iterable of
 *      `{ id?, event, data }` records into it. Caller owns the source;
 *      the function handles framing and keep-alive.
 *
 *   2. `watchPathEvents(path, signal)` — async iterable that yields a
 *      coalesced event per FS change at `path`. Built on native
 *      `fs.watch({ recursive: true })`, debounced 250 ms to swallow
 *      atomic-rename bursts. Stops when the abort signal fires.
 *
 * Together these let the watch endpoints (`/api/plans/:slug/watch`,
 * `/api/config/watch`, `/api/inspect/watch`) be one-liners.
 */

import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { existsSync, watch as fsWatch } from 'node:fs';

export interface SseRecord {
  id?: string;
  event?: string;
  data: unknown;
}

/**
 * Pump SSE records from `source` into the response. The caller is
 * responsible for the source's lifecycle: when the source closes, the
 * stream ends; when the client disconnects, hono aborts the stream and
 * the source's `signal` fires.
 *
 * Records are framed as standard text/event-stream:
 *
 *   id: <id>           (optional, enables Last-Event-ID resume)
 *   event: <event>     (optional, defaults to "message")
 *   data: <json>
 *   <blank>
 *
 * A keep-alive comment is sent every 15 s so intermediaries (browser
 * EventSource, proxies) don't time out on quiet streams.
 */
export function streamEvents(
  c: Context,
  source: (signal: AbortSignal) => AsyncIterable<SseRecord>,
): Response {
  return stream(c, async (s) => {
    s.onAbort(() => ac.abort());
    const ac = new AbortController();
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const keepAlive = setInterval(() => {
      // Comment line — clients ignore it, but it keeps the pipe warm.
      void s.write(': keepalive\n\n').catch(() => undefined);
    }, 15_000);

    try {
      for await (const rec of source(ac.signal)) {
        if (ac.signal.aborted) break;
        let chunk = '';
        if (rec.id !== undefined) chunk += `id: ${rec.id}\n`;
        if (rec.event !== undefined) chunk += `event: ${rec.event}\n`;
        chunk += `data: ${JSON.stringify(rec.data)}\n\n`;
        await s.write(chunk);
      }
    } finally {
      clearInterval(keepAlive);
    }
  });
}

/**
 * Async iterable yielding one debounced event per FS change at `path`
 * (or any descendant when `path` is a directory). Stops when `signal`
 * aborts.
 *
 * Native `fs.watch({ recursive: true })` is supported on macOS/Windows
 * for years and on Linux from Node 20 — `engines.node` already requires
 * >= 20. Same pattern F12.6's skill watcher uses.
 */
export async function* watchPathEvents(
  path: string,
  signal: AbortSignal,
  opts: { debounceMs?: number } = {},
): AsyncIterable<SseRecord> {
  const debounceMs = opts.debounceMs ?? 250;
  if (!existsSync(path)) return;

  // We bridge fs.watch's callback-style API to an async iterator via a
  // queue + promise chain. Each FS event resolves the pending promise;
  // each `yield` awaits the next one.
  type Resolver = (v: IteratorResult<SseRecord>) => void;
  const queue: SseRecord[] = [];
  let waiting: Resolver | undefined;
  let closed = false;

  const push = (rec: SseRecord): void => {
    if (closed) return;
    if (waiting) {
      const r = waiting;
      waiting = undefined;
      r({ value: rec, done: false });
    } else {
      queue.push(rec);
    }
  };

  let debounceTimer: NodeJS.Timeout | undefined;
  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      push({ event: 'change', data: { at: Date.now() } });
    }, debounceMs);
  };

  let watcher: ReturnType<typeof fsWatch> | undefined;
  try {
    watcher = fsWatch(path, { recursive: true }, () => fire());
    watcher.on('error', () => undefined);
  } catch {
    // permissions / disappeared — yield nothing and exit.
    return;
  }

  const onAbort = (): void => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
    if (waiting) {
      const r = waiting;
      waiting = undefined;
      r({ value: undefined as unknown as SseRecord, done: true });
    }
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const next = await new Promise<IteratorResult<SseRecord>>((res) => {
        waiting = res;
      });
      if (next.done) return;
      yield next.value;
    }
  } finally {
    onAbort();
    signal.removeEventListener('abort', onAbort);
  }
}
