import { Command } from 'commander';
import { VERSION } from '../version.js';
import type { LogFormat, LogLevel } from '../log/logger.js';
import type { CliContext } from './context.js';
import { buildContext } from './context.js';
import { COMMAND_MODULES } from './registry.js';

export interface YaaoRunOptions {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => never;
}

interface GlobalFlags {
  cwd?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * Top-level CLI runner. Returns an exit code (commands can also call ctx.exit directly).
 */
export async function yaao(opts: YaaoRunOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv;
  const ctxBuilder = (flags: GlobalFlags): Promise<CliContext> => {
    const level: LogLevel = flags.verbose ? 'debug' : flags.quiet ? 'warn' : 'info';
    const format: LogFormat = flags.json ? 'json' : 'text';
    return buildContext({
      cwd: flags.cwd ?? opts.cwd,
      env: opts.env,
      level,
      format,
      exit: opts.exit,
    });
  };

  const program = new Command()
    .name('yaao')
    .description('yet another agent orchestrator')
    .version(VERSION)
    .option('--cwd <path>', 'run as if invoked from <path>')
    .option('--json', 'machine-readable output (line-delimited JSON)')
    .option('-v, --verbose', 'verbose logs (debug level)')
    .option('-q, --quiet', 'quiet logs (warn level only)');

  program.exitOverride();

  // Build the initial context with default flags so each command's register() has a Logger
  // ready. Per-invocation flags refine the logger inside the action via program.opts().
  const baseCtx = await ctxBuilder({});
  for (const mod of COMMAND_MODULES) {
    mod.register(program, baseCtx);
  }

  // Re-attach a preAction hook so each subcommand sees a Logger that respects global flags.
  program.hook('preAction', async (thisCommand, actionCommand) => {
    const flags = thisCommand.opts() as GlobalFlags;
    const refreshed = await ctxBuilder(flags);
    Object.assign(baseCtx, refreshed);
    // Suppress lint complaint about unused parameter; commander needs it in the signature.
    void actionCommand;
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err: unknown) {
    if (isCommanderExitError(err)) {
      return err.exitCode ?? 1;
    }
    throw err;
  }
}

function isCommanderExitError(err: unknown): err is { exitCode: number; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    String((err as { code: unknown }).code).startsWith('commander.')
  );
}
