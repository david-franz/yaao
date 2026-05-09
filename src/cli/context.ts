import type { Logger, LogFormat, LogLevel } from '../log/logger.js';
import { createLogger } from '../log/logger.js';
import type { YaaoConfig } from '../config/types.js';
import { DEFAULT_CONFIG } from '../config/types.js';

export interface CliContext {
  cwd: string;
  config: YaaoConfig;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
}

export interface BuildContextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  level?: LogLevel;
  format?: LogFormat;
  config?: YaaoConfig;
  exit?: (code: number) => never;
}

/**
 * F1.2 builds a placeholder context with the default config. F1.3 wires loadConfig()
 * in via the same shape; commands don't need to change when that lands.
 */
export async function buildContext(opts: BuildContextOptions = {}): Promise<CliContext> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const level: LogLevel = opts.level ?? 'info';
  const format: LogFormat = opts.format ?? 'text';
  const logger = createLogger({ level, format });
  const config = opts.config ?? DEFAULT_CONFIG;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  return { cwd, env, logger, config, exit };
}
