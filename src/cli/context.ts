import type { Logger, LogFormat, LogLevel } from '../log/logger.js';
import { createLogger } from '../log/logger.js';
import type { YaaoConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';
import { loadConfig, type ConfigPaths } from '../config/loader.js';

export interface CliContext {
  cwd: string;
  config: YaaoConfig;
  configPaths: ConfigPaths;
  logger: Logger;
  /** True if the user passed `--json` on the command line. Commands that emit
   * structured output should switch to JSON shape on stdout when set. */
  json: boolean;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
}

export interface BuildContextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  level?: LogLevel;
  format?: LogFormat;
  json?: boolean;
  config?: YaaoConfig;
  exit?: (code: number) => never;
}

/**
 * Build a CLI context. Resolves config (defaults → global → project → secrets → env).
 * Config errors propagate as YaaoError subclasses so the top-level handler can render them.
 */
export async function buildContext(opts: BuildContextOptions = {}): Promise<CliContext> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const level: LogLevel = opts.level ?? 'info';
  const format: LogFormat = opts.format ?? 'text';
  const logger = createLogger({ level, format });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  if (opts.config) {
    return { cwd, env, logger, json: Boolean(opts.json), config: opts.config, configPaths: {}, exit };
  }
  const { config, paths } = await loadConfig({ cwd, env });
  return { cwd, env, logger, json: Boolean(opts.json), config, configPaths: paths, exit };
}

/**
 * Build a context that always uses the compiled-in defaults (skipping disk lookup).
 * Used by the init command before a project config exists.
 */
export function buildDefaultContext(opts: BuildContextOptions = {}): CliContext {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const level: LogLevel = opts.level ?? 'info';
  const format: LogFormat = opts.format ?? 'text';
  const logger = createLogger({ level, format });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  return { cwd, env, logger, json: Boolean(opts.json), config: DEFAULT_CONFIG, configPaths: {}, exit };
}
