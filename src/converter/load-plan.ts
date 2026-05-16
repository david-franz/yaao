import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseMarkdownPlan, type ParsedPlan } from '../planner/markdown.js';
import { parseSpecKit } from '../planner/speckit.js';
import { YaaoError } from '../log/errors.js';

export type PlanInputFormat = 'markdown' | 'speckit' | 'auto';

export interface LoadInputOptions {
  cwd: string;
  /** Path to a `.md` file, a Spec Kit triplet directory, or a directory containing many plans. */
  input: string;
  format?: PlanInputFormat;
}

export interface LoadInputResult {
  format: 'markdown' | 'speckit';
  plan: ParsedPlan;
  /** Absolute path(s) read. */
  sources: string[];
}

/**
 * Single-plan loader. Auto-detects markdown vs Spec Kit. For a directory that
 * doesn't itself contain `tasks.md`, the caller should use `discoverPlans` and
 * iterate.
 */
export function loadInputPlan(opts: LoadInputOptions): LoadInputResult {
  const abs = resolve(opts.cwd, opts.input);
  if (!existsSync(abs)) {
    throw new YaaoError({ code: 'YAAO_INPUT_PLAN_MISSING', message: `input plan not found: ${abs}` });
  }
  const explicit = opts.format ?? 'auto';
  const stat = statSync(abs);

  if (stat.isDirectory()) {
    const tasksPath = join(abs, 'tasks.md');
    if (existsSync(tasksPath)) {
      if (explicit === 'markdown') {
        throw new YaaoError({
          code: 'YAAO_INPUT_PLAN_FORMAT_MISMATCH',
          message: `${abs} looks like a Spec Kit directory; remove --from markdown`,
        });
      }
      return loadSpecKitDir(abs);
    }
    throw new YaaoError({
      code: 'YAAO_INPUT_PLAN_NOT_SPECKIT',
      message: `${abs} is a directory and not a Spec Kit triplet; use \`yaao convert <dir>\` with the recursive flow (the CLI walks it automatically)`,
    });
  }

  // Single file — markdown.
  if (explicit === 'speckit') {
    throw new YaaoError({
      code: 'YAAO_INPUT_PLAN_FORMAT_MISMATCH',
      message: `${abs} is a single file; Spec Kit requires a directory`,
    });
  }
  const body = readFileSync(abs, 'utf8');
  return { format: 'markdown', plan: parseMarkdownPlan(body), sources: [abs] };
}

export interface DiscoveredPlan {
  /** Absolute path; for Spec Kit, the triplet directory. For markdown, the .md file. */
  path: string;
  format: 'markdown' | 'speckit';
  /** Suggested output slug derived from the path. */
  slug: string;
}

/**
 * Walk `input` recursively and return every plan it contains. Rules:
 *  - A directory containing `tasks.md` is a Spec Kit triplet — emit it once and
 *    do not descend further into it.
 *  - Other `.md` files are individual markdown plans.
 *  - Skip `.git`, `node_modules`, `.yaao/exec`, `.yaao/runs`, `.yaao/worktrees`,
 *    and any directory whose name starts with `.` and isn't `.yaao`.
 *
 * If `input` is a single file, returns one entry. If it's a Spec Kit directory,
 * returns one entry for that triplet. Otherwise walks.
 */
export function discoverPlans(opts: LoadInputOptions): DiscoveredPlan[] {
  const abs = resolve(opts.cwd, opts.input);
  if (!existsSync(abs)) {
    throw new YaaoError({ code: 'YAAO_INPUT_PLAN_MISSING', message: `input plan not found: ${abs}` });
  }
  const stat = statSync(abs);
  if (stat.isFile()) {
    if (!abs.endsWith('.md')) {
      throw new YaaoError({
        code: 'YAAO_INPUT_PLAN_FORMAT_MISMATCH',
        message: `${abs} is not a .md file`,
      });
    }
    return [{ path: abs, format: 'markdown', slug: basename(abs, '.md') }];
  }
  // Directory — Spec Kit at the top?
  if (existsSync(join(abs, 'tasks.md'))) {
    return [{ path: abs, format: 'speckit', slug: basename(abs) }];
  }
  const found: DiscoveredPlan[] = [];
  walk(abs, found);
  if (found.length === 0) {
    throw new YaaoError({
      code: 'YAAO_INPUT_NO_PLANS_FOUND',
      message: `no plan files (.md or Spec Kit triplets) found under ${abs}`,
    });
  }
  return found;
}

function walk(dir: string, out: DiscoveredPlan[]): void {
  // Spec Kit triplet: stop descending into this directory and record it once.
  if (existsSync(join(dir, 'tasks.md'))) {
    out.push({ path: dir, format: 'speckit', slug: basename(dir) });
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (shouldSkip(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && entry.endsWith('.md')) {
      out.push({ path: full, format: 'markdown', slug: basename(entry, '.md') });
    }
  }
}

function shouldSkip(name: string): boolean {
  if (name === '.git') return true;
  if (name === 'node_modules') return true;
  if (name === 'exec' || name === 'runs' || name === 'worktrees') return true; // .yaao internals
  if (name.startsWith('.') && name !== '.yaao') return true;
  return false;
}

function loadSpecKitDir(abs: string): LoadInputResult {
  const tasksPath = join(abs, 'tasks.md');
  const specPath = join(abs, 'spec.md');
  const planPath = join(abs, 'plan.md');
  const tasks = readFileSync(tasksPath, 'utf8');
  const plan = parseSpecKit({
    tasks,
    ...(existsSync(specPath) ? { spec: readFileSync(specPath, 'utf8') } : {}),
    ...(existsSync(planPath) ? { plan: readFileSync(planPath, 'utf8') } : {}),
  });
  return {
    format: 'speckit',
    plan,
    sources: [tasksPath, ...(existsSync(specPath) ? [specPath] : []), ...(existsSync(planPath) ? [planPath] : [])],
  };
}
