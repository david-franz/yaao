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
