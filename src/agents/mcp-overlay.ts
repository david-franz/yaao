import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { McpServerConfig } from './backend.js';

/**
 * Per-spawn MCP overlay handle. The backend writes a transient config file
 * in the format its CLI accepts, points the CLI at it (via the file's
 * default location, an env var, or a flag — backend-specific), and calls
 * `restore()` after the spawn completes to remove the file. If a file
 * pre-existed at the overlay path the original contents are restored;
 * otherwise the overlay file is deleted outright.
 */
export interface OverlayHandle {
  /** Absolute path of the overlay file the backend should point its CLI at. */
  path: string;
  /** Idempotent. Safe to call multiple times. */
  restore(): void;
}

export interface CursorOverlayOptions {
  cwd: string;
  mcpServers: McpServerConfig[];
}

/**
 * Write a per-spawn `.cursor/mcp.json` inside the worktree (cwd).
 *
 * Cursor reads `.cursor/mcp.json` relative to the workspace root. Each task
 * runs in its own worktree so the file is fresh per spawn — no cross-task
 * contention. If a `.cursor/mcp.json` already exists (e.g. the user has
 * pre-existing rules they committed to the repo), it's backed up to
 * `mcp.json.yaao-bak` for the duration of the spawn and restored on
 * `restore()`. Concurrent spawns within one cwd are protected by the F16.1
 * worktree-per-task isolation; same-cwd concurrent spawns (the planner
 * path) are not currently exercised by F14.2 and would need the lockfile
 * approach described in the F14.2 doc to support.
 */
export function writeCursorOverlay(opts: CursorOverlayOptions): OverlayHandle | undefined {
  if (opts.mcpServers.length === 0) return undefined;
  const dir = resolve(opts.cwd, '.cursor');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mcp.json');
  const backup = `${path}.yaao-bak`;
  let hadOriginal = false;
  if (existsSync(path)) {
    writeFileSync(backup, readFileSync(path));
    hadOriginal = true;
  }
  const obj = {
    mcpServers: Object.fromEntries(
      opts.mcpServers.map((s) => [
        s.name,
        {
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
        },
      ]),
    ),
  };
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return {
    path,
    restore: (): void => {
      try {
        if (hadOriginal) {
          writeFileSync(path, readFileSync(backup));
          rmSync(backup, { force: true });
        } else {
          rmSync(path, { force: true });
        }
      } catch {
        // restore is best-effort; the next spawn will overwrite anyway
      }
    },
  };
}

export interface CopilotOverlayOptions {
  cwd: string;
  mcpServers: McpServerConfig[];
}

/**
 * Write a per-spawn `.vscode/mcp.json` inside the worktree (cwd).
 *
 * `gh copilot agent run` reads its MCP server set from `.vscode/mcp.json`.
 * Same backup-restore pattern as Cursor. As with Cursor, task-per-worktree
 * isolation means no cross-task contention; the same-cwd concurrent-spawn
 * case is out of scope for F14.2.
 */
export function writeCopilotOverlay(opts: CopilotOverlayOptions): OverlayHandle | undefined {
  if (opts.mcpServers.length === 0) return undefined;
  const dir = resolve(opts.cwd, '.vscode');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mcp.json');
  const backup = `${path}.yaao-bak`;
  let hadOriginal = false;
  if (existsSync(path)) {
    writeFileSync(backup, readFileSync(path));
    hadOriginal = true;
  }
  const obj = {
    servers: Object.fromEntries(
      opts.mcpServers.map((s) => [
        s.name,
        {
          type: 'stdio',
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
        },
      ]),
    ),
  };
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return {
    path,
    restore: (): void => {
      try {
        if (hadOriginal) {
          writeFileSync(path, readFileSync(backup));
          rmSync(backup, { force: true });
        } else {
          rmSync(path, { force: true });
        }
      } catch {
        // ignore — best effort
      }
    },
  };
}

export interface CodexOverlayOptions {
  cwd: string;
  mcpServers: McpServerConfig[];
  /** Run + task identifiers used to namespace the overlay file under .yaao/runs/. */
  runId?: string;
  taskId?: string;
}

/**
 * Write a per-spawn TOML overlay listing the MCP servers Codex should
 * register at startup.
 *
 * Today's Codex CLI does not have a documented `--config` flag; the
 * shipped emitter ([src/skills/emitters/codex.ts]) writes
 * `.yaao/codex-mcp-overlay.toml` which the user references manually from
 * their `~/.codex/config.toml`. F14.2 writes a per-spawn variant in the
 * worktree so the path is stable and reproducible across runs; the actual
 * flag/env-var wiring is left for F14.7's reality-check phase to nail
 * down. When Codex supports a config flag, the backend's `buildArgs` will
 * pick it up — until then, the overlay file is a deliverable artifact in
 * the worktree (visible to the user, inspectable from the journal) even
 * if Codex itself doesn't read it yet.
 *
 * No backup-restore: the path is yaao-owned and lives under the worktree,
 * so there's nothing to clobber.
 */
export function writeCodexOverlay(opts: CodexOverlayOptions): OverlayHandle | undefined {
  if (opts.mcpServers.length === 0) return undefined;
  const path = resolve(opts.cwd, '.yaao', 'codex-mcp-overlay.toml');
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = ['# yaao-managed Codex MCP overlay — regenerated per spawn'];
  for (const s of opts.mcpServers) {
    lines.push('', `[mcp_servers.${tomlKey(s.name)}]`);
    lines.push(`command = ${tomlString(s.command)}`);
    if (s.args && s.args.length > 0) {
      lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
    }
    if (s.env && Object.keys(s.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${tomlKey(s.name)}.env]`);
      for (const [k, v] of Object.entries(s.env)) {
        lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
      }
    }
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
  return {
    path,
    restore: (): void => {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

function tomlKey(s: string): string {
  // Quote keys that aren't a bare identifier.
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
