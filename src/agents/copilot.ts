import { execa } from 'execa';
import { SubprocessBackend } from './subprocess.js';
import type { AvailabilityReport, SpawnOptions } from './backend.js';

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

  override async isAvailable(): Promise<AvailabilityReport> {
    // Probe in two phases: gh itself, then `gh auth status`. Either failing yields a
    // specific reason rather than a generic "not on PATH".
    try {
      const v = await execa(this.opts.bin, ['--version'], { reject: false });
      const code = typeof v.exitCode === 'number' ? v.exitCode : -1;
      if (code !== 0) {
        return { available: false, reason: `gh --version exited ${code}` };
      }
      const auth = await execa(this.opts.bin, ['auth', 'status'], { reject: false });
      const aCode = typeof auth.exitCode === 'number' ? auth.exitCode : -1;
      if (aCode !== 0) {
        return {
          available: false,
          reason: 'gh is installed but not authenticated; run `gh auth login`',
        };
      }
      const out = (v.stdout?.toString() ?? '').trim();
      const m = out.match(/gh version ([\w.-]+)/);
      return { available: true, version: m?.[1] ?? out };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }
}
