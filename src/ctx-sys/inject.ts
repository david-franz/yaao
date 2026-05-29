import type { McpServerConfig } from '../agents/backend.js';
import type { YaaoConfig } from '../config/types.js';
import { detectCtxSys, type CtxSysStatus, type DetectOptions } from './detect.js';
import { buildMcpServers } from './mcp-config.js';
import { CTX_SYS_DIRECTIVE } from './directive.js';

export interface ResolveCtxSysOptions {
  /** Project root — also the `--project` the per-agent ctx-sys servers are pinned to. */
  cwd: string;
  config: YaaoConfig;
  /** True when the run disabled ctx-sys via `--no-ctx-sys`. */
  disabledForRun?: boolean;
  /** Injectable for tests; defaults to the real on-disk probe. */
  detect?: (opts: DetectOptions) => Promise<CtxSysStatus>;
}

export interface CtxSysInjection {
  /** Run-wide MCP servers (user-declared + ctx-sys when active). Empty when none. */
  mcpServers: McpServerConfig[];
  /** Context directive injected into every task, present only when ctx-sys is active. */
  directive?: string;
  /** Human-facing warning when ctx-sys was enabled but unusable (degraded run). */
  warning?: string;
}

/**
 * Decide how a run wires ctx-sys + user MCP servers.
 *
 * ctx-sys is an enhancement, not a hard dependency: when it's enabled +
 * installed + indexed (and not disabled for this run), every agent gets a
 * per-agent `ctx-sys serve --project <cwd>` stdio MCP server plus the
 * `context_query` directive. When it's enabled but unusable (binary missing,
 * or the project has no index) we degrade — return a warning, no ctx-sys
 * entry, no directive — rather than failing the run.
 *
 * `ctx-sys.auto-spawn: false` means "I'll wire ctx-sys myself" — yaao stays
 * out entirely (no entry, no directive, no probe). User-declared `mcp-servers`
 * flow regardless of ctx-sys.
 */
export async function resolveCtxSysInjection(opts: ResolveCtxSysOptions): Promise<CtxSysInjection> {
  const userServers = opts.config['mcp-servers'];
  const cfg = opts.config['ctx-sys'];
  const detect = opts.detect ?? detectCtxSys;

  let ctxSysProjectRoot: string | undefined;
  let directive: string | undefined;
  let warning: string | undefined;

  if (cfg.enabled && cfg['auto-spawn'] && !opts.disabledForRun) {
    const status = await detect({ cwd: opts.cwd, config: opts.config });
    if (!status.installed) {
      warning = `ctx-sys.enabled but the ctx-sys binary isn't on PATH — running without codebase context (${status.reason ?? 'not found'}).`;
    } else if (!status.initialized || status.indexed === false) {
      warning =
        'ctx-sys.enabled but this project has no index — run `ctx-sys index` first. Running without codebase context.';
    } else {
      ctxSysProjectRoot = opts.cwd;
      directive = CTX_SYS_DIRECTIVE;
    }
  }

  const mcpServers = buildMcpServers({
    ...(ctxSysProjectRoot !== undefined ? { ctxSysProjectRoot } : {}),
    userServers,
  });

  return {
    mcpServers,
    ...(directive !== undefined ? { directive } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}
