/**
 * Tail `.yaao/runs/<runId>/journal.jsonl` and yield each appended
 * `JournalEvent` as it appears. Used by `/api/runs/:runId/events` to
 * forward live run progress over SSE.
 *
 * Two-phase: replay everything that's already in the file (filtered by
 * Last-Event-ID if the client supplied one), then tail via `fs.watch`
 * for new lines. Each yielded record carries a numeric id == the
 * 1-based line number, so reconnecting clients can resume cleanly.
 *
 * Closes cleanly when the abort signal fires or when the journal
 * records `run:end` (the source-of-truth signal that no further events
 * will appear).
 */

import { existsSync, statSync, watch as fsWatch, openSync, closeSync, readSync } from 'node:fs';
import { dirname, basename } from 'node:path';

export interface JournalLineEvent {
  /** 1-based line number in journal.jsonl. */
  id: number;
  /** Parsed journal event (any shape from the discriminated union). */
  event: { t: string; [k: string]: unknown };
}

export interface TailJournalOptions {
  /** Path to journal.jsonl. May or may not exist when the iterator starts. */
  journalPath: string;
  /** Resume from after this line. Default 0 (replay everything). */
  lastEventId?: number;
  /** Cancel the tail. */
  signal: AbortSignal;
  /** Debounce window for watcher fires; default 50 ms (snappy). */
  debounceMs?: number;
}

/**
 * Yield every event from `journalPath` (after `lastEventId`) and then
 * every event appended thereafter, until the journal records `run:end`
 * or the signal aborts. Tolerant of a not-yet-existing file: waits for
 * it to appear via a parent-dir watcher.
 */
export async function* tailJournal(opts: TailJournalOptions): AsyncIterable<JournalLineEvent> {
  const debounceMs = opts.debounceMs ?? 50;
  let lineNo = 0; // actual 1-based line number being read from disk
  let bytesRead = 0;
  let pendingBuf = '';
  let ended = false;

  // Bridge fs.watch callbacks → async iterator the same way
  // src/web/sse.ts does. One pending promise; FS events resolve it.
  type Resolver = (v: IteratorResult<JournalLineEvent>) => void;
  const outQueue: JournalLineEvent[] = [];
  let waiting: Resolver | undefined;
  let closed = false;

  const emit = (rec: JournalLineEvent): void => {
    if (closed) return;
    if (waiting) {
      const r = waiting;
      waiting = undefined;
      r({ value: rec, done: false });
    } else {
      outQueue.push(rec);
    }
  };
  const finish = (): void => {
    closed = true;
    if (waiting) {
      const r = waiting;
      waiting = undefined;
      r({ value: undefined as unknown as JournalLineEvent, done: true });
    }
  };

  // Read whatever's new in the file (from `bytesRead` to EOF), parse
  // complete lines, emit each. Partial trailing line stays in
  // `pendingBuf` until the next read.
  const readNew = (): void => {
    if (!existsSync(opts.journalPath)) return;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(opts.journalPath);
    } catch {
      return;
    }
    if (stat.size <= bytesRead) return;
    const fd = openSync(opts.journalPath, 'r');
    try {
      const len = stat.size - bytesRead;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, bytesRead);
      bytesRead = stat.size;
      pendingBuf += buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    let nl = pendingBuf.indexOf('\n');
    while (nl >= 0) {
      const line = pendingBuf.slice(0, nl);
      pendingBuf = pendingBuf.slice(nl + 1);
      if (line.length > 0) {
        // Tolerate corrupt lines; the journal's own readEvents() does the
        // same (skip + continue).
        let parsed: { t: string; [k: string]: unknown } | undefined;
        try {
          parsed = JSON.parse(line) as { t: string; [k: string]: unknown };
        } catch {
          parsed = undefined;
        }
        lineNo += 1;
        const id = lineNo;
        if (parsed && id > (opts.lastEventId ?? 0)) {
          emit({ id, event: parsed });
          if (parsed.t === 'run:end') ended = true;
        }
      }
      nl = pendingBuf.indexOf('\n');
    }
  };

  let debounceTimer: NodeJS.Timeout | undefined;
  const fire = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      readNew();
      if (ended) finish();
    }, debounceMs);
  };

  // If the journal doesn't exist yet (e.g., a UI subscribed before the
  // run created its directory), watch the parent for its arrival.
  // Otherwise watch the file directly.
  let fileWatcher: ReturnType<typeof fsWatch> | undefined;
  let dirWatcher: ReturnType<typeof fsWatch> | undefined;

  const startFileWatcher = (): void => {
    if (fileWatcher) return;
    try {
      fileWatcher = fsWatch(opts.journalPath, () => fire());
      fileWatcher.on('error', () => undefined);
    } catch {
      // ignore; we'll keep relying on the dir watcher.
    }
  };

  const dir = dirname(opts.journalPath);
  const baseName = basename(opts.journalPath);
  if (existsSync(dir)) {
    try {
      dirWatcher = fsWatch(dir, (_ev, filename) => {
        if (filename === null || filename === baseName) {
          startFileWatcher();
          fire();
        }
      });
      dirWatcher.on('error', () => undefined);
    } catch {
      // ignore
    }
  }

  const onAbort = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (fileWatcher) fileWatcher.close();
    if (dirWatcher) dirWatcher.close();
    finish();
  };
  if (opts.signal.aborted) {
    onAbort();
    return;
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });

  // Initial replay.
  if (existsSync(opts.journalPath)) {
    startFileWatcher();
    readNew();
    if (ended) finish();
  }

  try {
    while (!closed) {
      if (outQueue.length > 0) {
        yield outQueue.shift()!;
        continue;
      }
      const next = await new Promise<IteratorResult<JournalLineEvent>>((res) => {
        waiting = res;
      });
      if (next.done) return;
      yield next.value;
    }
  } finally {
    onAbort();
    opts.signal.removeEventListener('abort', onAbort);
  }
}
