/**
 * Filesystem watcher for the skill roots an MCP server cares about. When a
 * skill directory is added, modified, or removed under `<cwd>/.yaao/skills/`
 * or `~/.yaao/skills/`, the watcher invokes the supplied `onChange` callback
 * (debounced) so the server can re-discover skills and call
 * `registerTool` / `.remove()` on the SDK to keep its tool catalog in sync.
 *
 * Built-in skills are NOT watched — they ship with the binary and don't
 * change at runtime.
 */
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';

export interface SkillWatcherOptions {
  /** Directories to watch. Non-existent entries are tolerated and ignored. */
  dirs: string[];
  /** Called after the configured debounce window elapses with at least one event. */
  onChange: () => void;
  /** Coalesce-window in ms. Default 250 — long enough to swallow the multiple
   *  events an atomic rename produces, short enough to feel instant. */
  debounceMs?: number;
}

export interface SkillWatcher {
  /** Begin watching. Idempotent. */
  start(): void;
  /** Stop watching and release fd handles. Idempotent. */
  stop(): void;
}

export function createSkillWatcher(opts: SkillWatcherOptions): SkillWatcher {
  const debounceMs = opts.debounceMs ?? 250;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let started = false;

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        opts.onChange();
      } catch {
        // Per-callback failures must not crash the watcher.
      }
    }, debounceMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      for (const dir of opts.dirs) {
        if (!existsSync(dir)) continue;
        try {
          // recursive: supported on macOS/Windows for years, and on Linux from
          // Node 20 — the engines field already requires >=20.
          const w = fsWatch(dir, { recursive: true }, () => fire());
          // EMFILE / EACCES can fire later as 'error' events; demote so they
          // don't take down the host process.
          w.on('error', () => undefined);
          watchers.push(w);
        } catch {
          // Bad permissions, vanished dir between existsSync and watch, etc.
          // Skill discovery falls back to the existing static scan.
        }
      }
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
      started = false;
    },
  };
}
