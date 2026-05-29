import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * F15.2 — Auto-register yaao's MCP server in the project's `.mcp.json`.
 *
 * Closes the previously-manual step between `yaao init` and "Claude Code
 * sees yaao tools." After F15.2, a fresh `yaao init` produces a
 * `.mcp.json` that Claude Code reads on next open, exposing the
 * `yaao_plan` / `yaao_convert` / `yaao_run` / `yaao_skill_<name>` MCP
 * tools without any further configuration.
 *
 * Behaviour:
 *   - Fresh repo (no .mcp.json) → write one with mcpServers.yaao only.
 *   - Existing .mcp.json with no `yaao` entry → merge in the yaao entry,
 *     preserve every sibling.
 *   - Existing .mcp.json with a matching `yaao` entry → no-op.
 *   - Existing .mcp.json with a NON-matching `yaao` entry → leave it
 *     untouched and return a warning. Force the overwrite with
 *     `--force`.
 *
 * Per-agent equivalents (`.cursor/mcp.json`, `~/.codex/config.toml`,
 * `.github/copilot-instructions.md`) are handled by the existing
 * `yaao skills install` emitters, which run as part of init's existing
 * flow. F15.2 owns only the top-level `.mcp.json`.
 */

export const YAAO_MCP_ENTRY = {
  command: 'yaao',
  args: ['serve'],
} as const;

export type McpRegisterAction = 'created' | 'merged' | 'unchanged' | 'conflict';

export interface McpRegisterResult {
  path: string;
  action: McpRegisterAction;
  warning?: string;
}

export interface McpRegisterOptions {
  cwd: string;
  /** Overwrite an existing non-matching `yaao` entry. */
  force?: boolean;
}

export function registerYaaoMcp(opts: McpRegisterOptions): McpRegisterResult {
  const cwd = resolve(opts.cwd);
  const path = join(cwd, '.mcp.json');

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify(
      { mcpServers: { yaao: { ...YAAO_MCP_ENTRY } } },
      null,
      2,
    );
    writeFileSync(path, `${body}\n`);
    return { path, action: 'created' };
  }

  let parsed: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
  } catch {
    // Malformed JSON — refuse to overwrite. Surface as a warning so the
    // user knows what's blocking auto-registration.
    return {
      path,
      action: 'conflict',
      warning: `existing ${path} is not valid JSON; left untouched`,
    };
  }

  const mcpServers: Record<string, unknown> = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const existing = mcpServers['yaao'];
  if (existing !== undefined) {
    if (entriesMatch(existing, YAAO_MCP_ENTRY)) {
      return { path, action: 'unchanged' };
    }
    if (!opts.force) {
      return {
        path,
        action: 'conflict',
        warning:
          "existing mcpServers.yaao entry differs from what we'd write — left untouched (rerun yaao init with --mcp --force to replace)",
      };
    }
  }

  mcpServers['yaao'] = { ...YAAO_MCP_ENTRY };
  const next = { ...parsed, mcpServers };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, action: existing === undefined ? 'merged' : 'merged' };
}

function entriesMatch(a: unknown, b: { command: string; args: readonly string[] }): boolean {
  if (!a || typeof a !== 'object') return false;
  const ar = a as { command?: unknown; args?: unknown };
  if (ar.command !== b.command) return false;
  if (!Array.isArray(ar.args)) return false;
  if (ar.args.length !== b.args.length) return false;
  for (let i = 0; i < b.args.length; i++) {
    if (ar.args[i] !== b.args[i]) return false;
  }
  return true;
}
