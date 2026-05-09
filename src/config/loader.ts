import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ConfigSchema, type YaaoConfig } from './schema.js';
import { ConfigValidationError, LiteralSecretError, MissingEnvError } from '../log/errors.js';

export interface LoadConfigOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ConfigPaths {
  global?: string;
  project?: string;
  secrets?: string;
}

export interface LoadResult {
  config: YaaoConfig;
  paths: ConfigPaths;
}

/**
 * Walks up from `cwd` looking for `.yaao/yaao.config.json`. Stops at the FS root or
 * at the nearest `.git/` directory (whichever comes first).
 */
export function findProjectConfig(cwd: string): { dir: string; file: string } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, '.yaao', 'yaao.config.json');
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { dir, file: candidate };
    }
    if (existsSync(join(dir, '.git'))) {
      // Don't search above the repo root.
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function configPaths(cwd: string): ConfigPaths {
  const out: ConfigPaths = {};
  const globalCandidate = join(homedir(), '.yaao', 'config.json');
  if (existsSync(globalCandidate)) out.global = globalCandidate;
  const project = findProjectConfig(cwd);
  if (project) {
    out.project = project.file;
    const secretsPath = join(project.dir, '.yaao', 'secrets.local.json');
    if (existsSync(secretsPath)) out.secrets = secretsPath;
  }
  return out;
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigValidationError({
      message: `failed to read config file: ${path}`,
      cause: err,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError({
      message: `${path} is not valid JSON: ${(err as Error).message}`,
      cause: err,
    });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merges b into a. Plain objects merge key-by-key; arrays and primitives replace.
 */
export function deepMerge<T>(a: T, b: unknown): T {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return (b === undefined ? a : (b as T));
  }
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}

const ENV_VAR_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/i;

/**
 * Recursively expands `${VAR}` strings against `env`. Throws `MissingEnvError` for any
 * unresolved variable. Strings that don't match the full ${VAR} pattern are left as-is.
 */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv, path: string[] = []): T {
  if (typeof value === 'string') {
    const m = value.match(ENV_VAR_RE);
    if (!m) return value;
    const varName = m[1];
    if (!varName) return value;
    const resolved = env[varName];
    if (resolved === undefined) {
      throw new MissingEnvError({
        message: `unresolved env var \${${varName}} at config path ${path.join('.') || '<root>'}`,
        varName,
      });
    }
    return resolved as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => expandEnv(v, env, [...path, String(i)])) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnv(v, env, [...path, k]);
    }
    return out as unknown as T;
  }
  return value;
}

interface SecretLeaf {
  value: string;
  jsonPath: string;
}

/**
 * Yields every leaf string found at agents.api.providers.<provider>.api-key in `obj`.
 */
function findApiKeyLeaves(obj: unknown): SecretLeaf[] {
  if (!isPlainObject(obj)) return [];
  const agents = obj['agents'];
  if (!isPlainObject(agents)) return [];
  const api = agents['api'];
  if (!isPlainObject(api)) return [];
  const providers = api['providers'];
  if (!isPlainObject(providers)) return [];
  const out: SecretLeaf[] = [];
  for (const [pname, p] of Object.entries(providers)) {
    if (!isPlainObject(p)) continue;
    const key = p['api-key'];
    if (typeof key === 'string') {
      out.push({ value: key, jsonPath: `agents.api.providers.${pname}.api-key` });
    }
  }
  return out;
}

function looksLikeEnvRef(v: string): boolean {
  return ENV_VAR_RE.test(v);
}

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadResult> {
  const paths = configPaths(opts.cwd);
  const layers: { name: 'global' | 'project'; data: unknown; file: string }[] = [];
  if (paths.global) layers.push({ name: 'global', data: readJson(paths.global), file: paths.global });
  if (paths.project) layers.push({ name: 'project', data: readJson(paths.project), file: paths.project });

  // Secret-in-config guard runs against non-secret layers.
  for (const layer of layers) {
    for (const leaf of findApiKeyLeaves(layer.data)) {
      if (!looksLikeEnvRef(leaf.value)) {
        throw new LiteralSecretError({
          message: `literal API key in non-secret config: ${leaf.jsonPath} (${layer.file})`,
          file: layer.file,
          jsonPath: leaf.jsonPath,
        });
      }
    }
  }

  let merged: unknown = { version: 1 };
  for (const layer of layers) {
    merged = deepMerge(merged, layer.data);
  }
  if (paths.secrets) {
    merged = deepMerge(merged, readJson(paths.secrets));
  }

  // Env-var expansion runs over the merged object (which now includes secrets).
  const expanded = expandEnv(merged, opts.env);

  const parsed = ConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigValidationError({
      message: issue
        ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
        : 'invalid configuration',
      path: issue?.path,
      cause: parsed.error,
    });
  }
  return { config: parsed.data, paths };
}
