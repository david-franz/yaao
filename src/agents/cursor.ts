import { SubprocessBackend } from './subprocess.js';
import type { AgentProcess, SpawnOptions } from './backend.js';
import { writeCursorOverlay, type OverlayHandle } from './mcp-overlay.js';

export interface CursorBackendOptions {
  bin?: string;
}

export function buildCursorArgs(opts: SpawnOptions): string[] {
  // cursor-agent supports --print for non-interactive output. Skills are picked up via
  // .cursor/rules/<name>.mdc files written by Phase 8 emitters; we don't pass them here.
  const args = ['--print'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  return args;
}

export class CursorBackend extends SubprocessBackend {
  constructor(opts: CursorBackendOptions = {}) {
    super({
      name: 'cursor',
      bin: opts.bin ?? 'cursor-agent',
      buildArgs: (o) => buildCursorArgs(o),
      promptOnStdin: true,
    });
  }

  override async spawn(spawnOpts: SpawnOptions): Promise<AgentProcess> {
    // F14.2: write a per-spawn `.cursor/mcp.json` so per-run MCP servers
    // (yaao's own server, ctx-sys, plan-declared `context.mcp-servers`)
    // actually reach Cursor. Without this overlay the SubprocessBackend
    // silently drops the mcpServers field — agents only ever see whatever
    // `yaao skills install` wrote into the user's checked-in
    // .cursor/mcp.json (which can't carry per-run state).
    const overlay = writeCursorOverlay({
      cwd: spawnOpts.cwd,
      mcpServers: spawnOpts.mcpServers ?? [],
    });
    return withOverlayCleanup(await super.spawn(spawnOpts), overlay);
  }
}

function withOverlayCleanup(proc: AgentProcess, overlay: OverlayHandle | undefined): AgentProcess {
  if (!overlay) return proc;
  const cleanup = (): void => overlay.restore();
  proc.completed.then(cleanup, cleanup);
  return proc;
}
