import { SubprocessBackend } from './subprocess.js';
import type { SpawnOptions } from './backend.js';

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
}
