export interface YaaoErrorOptions {
  code: string;
  message: string;
  hint?: string;
  cause?: unknown;
}

export class YaaoError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;
  constructor(opts: YaaoErrorOptions) {
    super(opts.message);
    this.name = new.target.name;
    this.code = opts.code;
    this.hint = opts.hint ?? DEFAULT_HINTS[opts.code];
    this.cause = opts.cause;
  }
}

/**
 * Default hint catalogue. Each code maps to a one-line, user-actionable suggestion.
 * Constructor-passed hints win over this table.
 */
export const DEFAULT_HINTS: Record<string, string> = {
  YAAO_NOT_INITIALIZED: "Run 'yaao init' to scaffold this project.",
  YAAO_CONFIG_INVALID: 'Fix the config file and re-run.',
  YAAO_LITERAL_SECRET:
    "Replace the literal value with '${ENV_VAR}' or move it to .yaao/secrets.local.json.",
  YAAO_MISSING_ENV: 'Set the env var in your shell or in .yaao/secrets.local.json.',
  YAAO_INIT_WRITE: 'Check filesystem permissions for the target directory.',
  YAAO_PLAN_NOT_FOUND: 'Check the path; relative paths are resolved against --cwd.',
  YAAO_PLAN_PARSE: 'Open the file at the reported line; YAML syntax must be valid.',
  YAAO_PLAN_INVALID: 'Fix the schema violations and re-run `yaao validate`.',
  YAAO_PLAN_INCLUDE_CYCLE: 'Break the include cycle by inlining or removing one of the entries.',
  YAAO_PLAN_INCLUDE_DEPTH: 'Flatten the include tree or raise maxIncludeDepth.',
  YAAO_GIT: 'Inspect the git command, stdout, and stderr in the error for the underlying cause.',
  YAAO_WORKTREE: 'Inspect the worktree path; remove leftovers via `yaao clean` if necessary.',
  YAAO_AGENT_DISABLED:
    "Set agents.<name>.enabled = true in yaao.config.json, choose an enabled agent for the task, or rerun with --allow-disabled-agents to downgrade to a warning.",
  YAAO_NO_ENABLED_AGENTS:
    'Enable at least one agent in yaao.config.json (set agents.<name>.enabled = true) or configure agents.api.providers with a resolvable API key.',
  YAAO_BASE_BRANCH_MISSING:
    "The plan's base-branch doesn't exist in this repo. Run `git branch` to see available branches, set defaults.base-branch in yaao.config.json, or pass --base-branch <name>.",
};

export class NotInitializedError extends YaaoError {
  constructor(opts: Omit<YaaoErrorOptions, 'code'>) {
    super({ ...opts, code: 'YAAO_NOT_INITIALIZED' });
  }
}

export class ConfigValidationError extends YaaoError {
  readonly path: (string | number)[] | undefined;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { path?: (string | number)[] }) {
    super({ ...opts, code: 'YAAO_CONFIG_INVALID' });
    this.path = opts.path;
  }
}

export class LiteralSecretError extends YaaoError {
  readonly file: string;
  readonly jsonPath: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { file: string; jsonPath: string }) {
    super({ ...opts, code: 'YAAO_LITERAL_SECRET' });
    this.file = opts.file;
    this.jsonPath = opts.jsonPath;
  }
}

export class MissingEnvError extends YaaoError {
  readonly varName: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { varName: string }) {
    super({
      ...opts,
      code: 'YAAO_MISSING_ENV',
      hint: opts.hint ?? `Set the env var ${opts.varName} in your shell or in .yaao/secrets.local.json.`,
    });
    this.varName = opts.varName;
  }
}

export class InitWriteError extends YaaoError {
  readonly path: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { path: string }) {
    super({ ...opts, code: 'YAAO_INIT_WRITE' });
    this.path = opts.path;
  }
}

export class PlanNotFoundError extends YaaoError {
  readonly path: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { path: string }) {
    super({ ...opts, code: 'YAAO_PLAN_NOT_FOUND' });
    this.path = opts.path;
  }
}

export class PlanParseError extends YaaoError {
  readonly file: string;
  readonly line?: number;
  readonly col?: number;
  constructor(
    opts: Omit<YaaoErrorOptions, 'code'> & { file: string; line?: number; col?: number },
  ) {
    super({ ...opts, code: 'YAAO_PLAN_PARSE' });
    this.file = opts.file;
    this.line = opts.line;
    this.col = opts.col;
  }
}

export class PlanValidationError extends YaaoError {
  readonly issues: { path: (string | number)[]; message: string }[];
  constructor(
    opts: Omit<YaaoErrorOptions, 'code'> & {
      issues: { path: (string | number)[]; message: string }[];
    },
  ) {
    super({ ...opts, code: 'YAAO_PLAN_INVALID' });
    this.issues = opts.issues;
  }
}

export class IncludeCycleError extends YaaoError {
  readonly cycle: string[];
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { cycle: string[] }) {
    super({ ...opts, code: 'YAAO_PLAN_INCLUDE_CYCLE' });
    this.cycle = opts.cycle;
  }
}

export class IncludeDepthError extends YaaoError {
  readonly depth: number;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { depth: number }) {
    super({ ...opts, code: 'YAAO_PLAN_INCLUDE_DEPTH' });
    this.depth = opts.depth;
  }
}

export class GitError extends YaaoError {
  readonly cmd: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  constructor(
    opts: Omit<YaaoErrorOptions, 'code'> & {
      cmd: string[];
      exitCode: number;
      stdout: string;
      stderr: string;
    },
  ) {
    super({ ...opts, code: 'YAAO_GIT' });
    this.cmd = opts.cmd;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
  }
}

export class WorktreeError extends YaaoError {
  readonly path?: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { path?: string }) {
    super({ ...opts, code: 'YAAO_WORKTREE' });
    this.path = opts.path;
  }
}

export class WorktreeMergeError extends WorktreeError {
  readonly conflicts: string[];
  constructor(
    opts: Omit<YaaoErrorOptions, 'code'> & { conflicts: string[]; path?: string },
  ) {
    super({ ...opts });
    this.conflicts = opts.conflicts;
  }
}

export class AgentUnavailableError extends YaaoError {
  readonly agent: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { agent: string }) {
    super({ ...opts, code: 'YAAO_AGENT_UNAVAILABLE' });
    this.agent = opts.agent;
  }
}

/**
 * Thrown at the backend-dispatch layer (both CLI `yaao run` and MCP
 * `yaao_run`) when a task targets an agent that has been disabled in
 * `agents.<name>.enabled`. The validation gate (`YAAO_PLAN_AGENT_DISABLED`)
 * fires first under normal flow; this error exists as defense-in-depth for
 * programmatic callers that bypass validation or for the
 * `--allow-disabled-agents` path where the gate has been deliberately
 * relaxed.
 */
export class AgentDisabledError extends YaaoError {
  readonly agent: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { agent: string }) {
    super({ ...opts, code: 'YAAO_AGENT_DISABLED' });
    this.agent = opts.agent;
  }
}

/**
 * Thrown when no agent in the user's config is usable: every CLI agent has
 * `enabled: false` AND no API provider key resolves. Surfaces both at the
 * converter's fallback walk and at the planner's backend resolver.
 */
export class NoEnabledAgentsError extends YaaoError {
  constructor(opts: Omit<YaaoErrorOptions, 'code'>) {
    super({ ...opts, code: 'YAAO_NO_ENABLED_AGENTS' });
  }
}

export class AgentTimeoutError extends YaaoError {
  readonly agent: string;
  readonly timeoutMs: number;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { agent: string; timeoutMs: number }) {
    super({ ...opts, code: 'YAAO_AGENT_TIMEOUT' });
    this.agent = opts.agent;
    this.timeoutMs = opts.timeoutMs;
  }
}

export class AgentCancelledError extends YaaoError {
  readonly agent: string;
  readonly reason?: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { agent: string; reason?: string }) {
    super({ ...opts, code: 'YAAO_AGENT_CANCELLED' });
    this.agent = opts.agent;
    this.reason = opts.reason;
  }
}

export class AgentNonZeroExitError extends YaaoError {
  readonly agent: string;
  readonly exitCode: number;
  /** Shell command (e.g. validation command) whose failure produced this error. */
  readonly command?: string;
  /** Tail of stdout from the failing command — useful for retry context and CLI surfacing. */
  readonly stdoutTail?: string;
  /** Tail of stderr from the failing command. */
  readonly stderrTail?: string;
  constructor(
    opts: Omit<YaaoErrorOptions, 'code'> & {
      agent: string;
      exitCode: number;
      command?: string;
      stdoutTail?: string;
      stderrTail?: string;
    },
  ) {
    super({ ...opts, code: 'YAAO_AGENT_NONZERO' });
    this.agent = opts.agent;
    this.exitCode = opts.exitCode;
    if (opts.command !== undefined) this.command = opts.command;
    if (opts.stdoutTail !== undefined) this.stdoutTail = opts.stdoutTail;
    if (opts.stderrTail !== undefined) this.stderrTail = opts.stderrTail;
  }
}

export class ApiKeyMissingError extends YaaoError {
  readonly provider: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { provider: string }) {
    super({ ...opts, code: 'YAAO_API_KEY_MISSING' });
    this.provider = opts.provider;
  }
}

export class ApiToolLoopBudgetError extends YaaoError {
  readonly limit: number;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { limit: number }) {
    super({ ...opts, code: 'YAAO_API_TOOL_BUDGET' });
    this.limit = opts.limit;
  }
}

export class ApiToolError extends YaaoError {
  readonly tool: string;
  constructor(opts: Omit<YaaoErrorOptions, 'code'> & { tool: string }) {
    super({ ...opts, code: 'YAAO_API_TOOL_ERROR' });
    this.tool = opts.tool;
  }
}
