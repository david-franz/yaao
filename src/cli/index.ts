import { Command } from 'commander';
import { VERSION } from '../version.js';
import type { LogFormat, LogLevel } from '../log/logger.js';
import type { CliContext } from './context.js';
import { buildContext, buildDefaultContext } from './context.js';
import { COMMAND_MODULES } from './registry.js';
import { YaaoError } from '../log/errors.js';
import { isExitSignal } from './exit-signal.js';

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
  const buildArgs = (flags: GlobalFlags) => {
    const level: LogLevel = flags.verbose ? 'debug' : flags.quiet ? 'warn' : 'info';
    const format: LogFormat = flags.json ? 'json' : 'text';
    return {
      cwd: flags.cwd ?? opts.cwd,
      env: opts.env,
      level,
      format,
      exit: opts.exit,
    } as const;
  };
  const ctxBuilder = (flags: GlobalFlags, bootstrap: boolean): Promise<CliContext> | CliContext => {
    return bootstrap ? buildDefaultContext(buildArgs(flags)) : buildContext(buildArgs(flags));
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

  // Use a default-config ctx for registration; preAction loads the real config so any
  // YaaoError (literal secret, missing env, schema violation) bubbles up before the action.
  // Bootstrap commands (init) keep using defaults so they can still run when the project
  // config is missing or invalid.
  const baseCtx: CliContext = buildDefaultContext({ cwd: opts.cwd, env: opts.env, exit: opts.exit });
  const moduleByName = new Map<string, (typeof COMMAND_MODULES)[number]>();
  for (const mod of COMMAND_MODULES) {
    moduleByName.set(mod.name, mod);
    mod.register(program, baseCtx);
  }

  program.hook('preAction', async (thisCommand, actionCommand) => {
    const flags = thisCommand.opts() as GlobalFlags;
    const mod = moduleByName.get(actionCommand.name());
    const bootstrap = mod?.bootstrap === true;
    const refreshed = await ctxBuilder(flags, bootstrap);
    Object.assign(baseCtx, refreshed);
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err: unknown) {
    if (isExitSignal(err)) {
      // ctx.exit() was used; let the caller (bin or test) decide what to do.
      throw err;
    }
    if (isCommanderExitError(err)) {
      return err.exitCode ?? 1;
    }
    if (err instanceof YaaoError) {
      baseCtx.logger.error(err.message, { code: err.code });
      if (err.hint) baseCtx.logger.error(`hint: ${err.hint}`);
      return 1;
    }
    const e = err as Error;
    baseCtx.logger.error('unexpected error', { err: e?.message ?? String(err), stack: e?.stack });
    return 99;
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
