export { VERSION } from './version.js';
export { yaao } from './cli/index.js';
export type { YaaoRunOptions } from './cli/index.js';
export type { CliContext } from './cli/context.js';
export type { CommandModule } from './cli/command.js';
export type { Logger, LoggerOptions, LogLevel, LogFormat } from './log/logger.js';
export { createLogger } from './log/logger.js';
export type { YaaoConfig, AgentName, ApiProvider } from './config/types.js';
export { DEFAULT_CONFIG, AGENT_NAMES } from './config/types.js';
export { ConfigSchema } from './config/schema.js';
export {
  PlanSchema,
  TaskSchema,
  ApiBindingSchema,
  PlanHeaderSchema,
  PlanConfigSchema,
  PlanContextSchema,
  ValidationSchema,
  DurationSchema,
  resolvePlan,
} from './plan/schema/types.js';
export type {
  Plan,
  Task,
  PlanHeader,
  PlanConfig,
  ApiBinding,
  ResolvedPlan,
  ResolvedTask,
  ResolvedPlanConfig,
  ResolvedPlanContext,
  ResolveOptions,
} from './plan/schema/types.js';
export { loadConfig, configPaths, findProjectConfig, deepMerge, expandEnv } from './config/loader.js';
export type { ConfigPaths, LoadConfigOptions, LoadResult } from './config/loader.js';
export {
  YaaoError,
  NotInitializedError,
  ConfigValidationError,
  LiteralSecretError,
  MissingEnvError,
  InitWriteError,
  DEFAULT_HINTS,
} from './log/errors.js';
