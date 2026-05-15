import type { McpServerConfig } from '../agents/backend.js';
import type { CtxSysHandle } from './spawn.js';
import { YaaoError } from '../log/errors.js';

export const RESERVED_MCP_NAMES = new Set(['yaao', 'ctx-sys']);

export interface BuildMcpServersOptions {
  /** yaao's own MCP server (Phase 12 will land this). Omit if not yet running. */
  yaaoServer?: McpServerConfig;
  /** A ctx-sys handle if F7.1 spawned one. */
  ctxSys?: CtxSysHandle;
  /** User-declared MCP servers from `yaao.config.json.mcp-servers`. */
  userServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Override the ctx-sys binary name when materializing the entry. */
  ctxSysBin?: string;
}

/**
 * Compose the per-spawn MCP server list. The list is deterministic — yaao first, then
 * ctx-sys (when present), then user-declared servers in alphabetical order. Reserved
 * names (`yaao`, `ctx-sys`) cannot be used by user-declared servers.
 */
export function buildMcpServers(opts: BuildMcpServersOptions): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  if (opts.yaaoServer) out.push(opts.yaaoServer);
  if (opts.ctxSys) {
    out.push({
      name: 'ctx-sys',
      command: opts.ctxSysBin ?? 'ctx-sys',
      args: ['serve', '--socket', opts.ctxSys.socketPath],
      env: {},
    });
  }
  const users = opts.userServers ?? {};
  const names = Object.keys(users).sort();
  for (const name of names) {
    if (RESERVED_MCP_NAMES.has(name)) {
      throw new YaaoError({
        code: 'YAAO_MCP_RESERVED_NAME',
        message: `MCP server name '${name}' is reserved`,
      });
    }
    const s = users[name];
    if (!s) continue;
    out.push({
      name,
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
    });
  }
  return out;
}
