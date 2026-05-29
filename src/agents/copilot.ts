import { execa } from 'execa';
import { SubprocessBackend } from './subprocess.js';
import type { AgentProcess, AvailabilityReport, SpawnOptions } from './backend.js';
import { writeCopilotOverlay, type OverlayHandle } from './mcp-overlay.js';

export interface CopilotBackendOptions {
  bin?: string;
}

export function buildCopilotArgs(opts: SpawnOptions): string[] {
  // gh's Copilot agentic surface evolves; we use the modern `gh copilot agent run` form
  // with the prompt fed via stdin. Users pin a tested version in agents.copilot.bin.
  const args = ['copilot', 'agent', 'run'];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  return args;
}

export class CopilotBackend extends SubprocessBackend {
  constructor(opts: CopilotBackendOptions = {}) {
    super({
      name: 'copilot',
      bin: opts.bin ?? 'gh',
      buildArgs: (o) => buildCopilotArgs(o),
      promptOnStdin: true,
    });
  }

  override async spawn(spawnOpts: SpawnOptions): Promise<AgentProcess> {
    // F14.2: write a per-spawn .vscode/mcp.json so per-run MCP servers reach
    // Copilot. Same backup-restore shape as Cursor.
    const overlay = writeCopilotOverlay({
      cwd: spawnOpts.cwd,
      mcpServers: spawnOpts.mcpServers ?? [],
    });
    return withOverlayCleanup(await super.spawn(spawnOpts), overlay);
  }

  override async isAvailable(): Promise<AvailabilityReport> {
    // F14.7 — Four-phase probe:
    //   1. gh on PATH
    //   2. gh authenticated
    //   3. gh-copilot extension installed
    //   4. `gh copilot --version` reports a version
    //
    // Before F14.7 this method reported the gh binary's version when gh
    // was installed, which surfaced as "✔ copilot v2.88.1" in
    // `yaao agents` — green and confidently wrong, since the version
    // belonged to the gh CLI itself, not to the gh-copilot extension
    // that provides the agentic command. With the four-phase probe each
    // failure mode gets a specific reason and a clear "what to install"
    // hint, and the reported version is the gh-copilot extension's
    // version when one is detected.
    try {
      // Phase 1 — gh on PATH
      const v = await execa(this.opts.bin, ['--version'], { reject: false });
      if (v.failed && typeof v.exitCode !== 'number') {
        return {
          available: false,
          reason: `binary '${this.opts.bin}' not found on PATH (install gh or set agents.copilot.bin in yaao.config.json)`,
        };
      }
      const code = typeof v.exitCode === 'number' ? v.exitCode : -1;
      if (code !== 0) {
        return { available: false, reason: `${this.opts.bin} --version exited ${code}` };
      }

      // Phase 2 — gh authenticated
      const auth = await execa(this.opts.bin, ['auth', 'status'], { reject: false });
      const aCode = typeof auth.exitCode === 'number' ? auth.exitCode : -1;
      if (aCode !== 0) {
        return {
          available: false,
          reason: 'gh is installed but not authenticated; run `gh auth login`',
        };
      }

      // Phase 3 — gh-copilot extension installed
      const ext = await execa(this.opts.bin, ['extension', 'list'], { reject: false });
      const extCode = typeof ext.exitCode === 'number' ? ext.exitCode : -1;
      const extList = (ext.stdout?.toString() ?? '').toLowerCase();
      const hasCopilotExt = extCode === 0 && extList.includes('gh-copilot');
      if (!hasCopilotExt) {
        return {
          available: false,
          reason:
            'gh-copilot extension not installed; run `gh extension install github/gh-copilot`',
        };
      }

      // Phase 4 — read the extension's own version, not gh's. The
      // `gh copilot --version` form was added when gh-copilot started
      // versioning itself; fall back to the `gh extension list` row when
      // not supported.
      const copilotV = await execa(this.opts.bin, ['copilot', '--version'], { reject: false });
      const copilotCode = typeof copilotV.exitCode === 'number' ? copilotV.exitCode : -1;
      let version: string | undefined;
      if (copilotCode === 0) {
        const out = (copilotV.stdout?.toString() ?? '').trim();
        const m = out.match(/(\d+\.\d+(?:\.\d+)?[\w.-]*)/);
        version = m?.[1] ?? out;
      } else {
        // Fall back to parsing the version column out of `gh extension list`.
        const row = extList.split('\n').find((l) => l.includes('gh-copilot'));
        const m = row?.match(/(\d+\.\d+(?:\.\d+)?[\w.-]*)/);
        version = m?.[1];
      }
      return { available: true, ...(version ? { version } : {}) };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }
}

function withOverlayCleanup(proc: AgentProcess, overlay: OverlayHandle | undefined): AgentProcess {
  if (!overlay) return proc;
  const cleanup = (): void => overlay.restore();
  proc.completed.then(cleanup, cleanup);
  return proc;
}
