import { yaao } from '../../src/cli/index.js';
import { ExitSignal, isExitSignal } from '../../src/cli/exit-signal.js';

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class MemoryStream {
  buf = '';
  write(chunk: string | Uint8Array): boolean {
    this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

/**
 * Runs the CLI in-process with stdout/stderr captured. Calls to ctx.exit() and to
 * commander's exitOverride() are caught and translated into CliRunResult.exitCode.
 */
export async function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliRunResult> {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const realOutWrite = process.stdout.write;
  const realErrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => out.write(chunk)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => err.write(chunk)) as typeof process.stderr.write;

  let exitCode = 0;
  const exit = (code: number): never => {
    throw new ExitSignal(code);
  };

  try {
    exitCode = await yaao({
      argv: ['node', 'yaao', ...args],
      cwd: opts.cwd,
      env: opts.env,
      exit,
    });
  } catch (e) {
    if (isExitSignal(e)) {
      exitCode = e.exitCode;
    } else {
      throw e;
    }
  } finally {
    process.stdout.write = realOutWrite;
    process.stderr.write = realErrWrite;
  }

  return { exitCode, stdout: out.buf, stderr: err.buf };
}
