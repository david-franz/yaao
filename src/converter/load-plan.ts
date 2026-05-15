import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseMarkdownPlan, type ParsedPlan } from '../planner/markdown.js';
import { parseSpecKit } from '../planner/speckit.js';
import { YaaoError } from '../log/errors.js';

export type PlanInputFormat = 'markdown' | 'speckit' | 'auto';

export interface LoadInputOptions {
  cwd: string;
  /** Path to a `.md` file or a Spec Kit directory. */
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
 * F10.2 + F10.3: load an implementation plan from disk into the shared `ParsedPlan` IR.
 * Auto-detects markdown (single file) vs Spec Kit (directory containing tasks.md).
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
    if (!existsSync(tasksPath)) {
      throw new YaaoError({
        code: 'YAAO_INPUT_PLAN_NOT_SPECKIT',
        message: `${abs} is a directory but does not contain tasks.md`,
      });
    }
    if (explicit === 'markdown') {
      throw new YaaoError({
        code: 'YAAO_INPUT_PLAN_FORMAT_MISMATCH',
        message: `${abs} looks like a Spec Kit directory; remove --from markdown`,
      });
    }
    const tasks = readFileSync(tasksPath, 'utf8');
    const specPath = join(abs, 'spec.md');
    const planPath = join(abs, 'plan.md');
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
