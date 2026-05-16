import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { YaaoConfig } from '../config/types.js';
import { PlanSchema, type Plan, type Task } from '../plan/schema/plan.js';
import { loadInputPlan, discoverPlans, type PlanInputFormat } from './load-plan.js';
import { assignAgent, type AgentRule } from './assign-agent.js';
import { inferDependencies, type InferMode } from './infer-deps.js';
import { PlanValidationError } from '../log/errors.js';

export interface ConvertOptions {
  cwd: string;
  config: YaaoConfig;
  input: string;
  out?: string;
  format?: PlanInputFormat;
  agentRules?: AgentRule[];
  disableBuiltinAgentRules?: boolean;
  infer?: InferMode;
  inferThreshold?: number;
  apiAvailable?: boolean;
}

export interface ConvertResult {
  plan: Plan;
  outPath: string;
  warnings: string[];
  inferred: { from: string; on: string; confidence: number; reason: string }[];
}

export async function convertPlan(opts: ConvertOptions): Promise<ConvertResult> {
  const cwd = resolve(opts.cwd);
  const loaded = loadInputPlan({
    cwd,
    input: opts.input,
    ...(opts.format !== undefined ? { format: opts.format } : {}),
  });
  const parsed = loaded.plan;
  const warnings: string[] = parsed.issues
    .filter((i) => i.code !== 'YAAO_PLAN_TASK_MISSING_HEADING') // table-only tasks are still convertible
    .map((i) => `${i.code}: ${i.message}`);

  const planName = parsed.metadata['name'] ?? slugify(parsed.title || basename(opts.input, extname(opts.input)));

  // Inference (off by default).
  const inferred = inferDependencies(parsed.tasks, {
    ...(opts.infer !== undefined ? { mode: opts.infer } : {}),
    ...(opts.inferThreshold !== undefined ? { threshold: opts.inferThreshold } : {}),
  });

  const tasks: Task[] = parsed.tasks.map((t) => {
    const assignment = assignAgent(t, {
      config: opts.config,
      ...(opts.agentRules !== undefined ? { rules: opts.agentRules } : {}),
      ...(opts.disableBuiltinAgentRules !== undefined ? { disableBuiltins: opts.disableBuiltinAgentRules } : {}),
      ...(opts.apiAvailable !== undefined ? { apiAvailable: opts.apiAvailable } : {}),
    });
    const additionalDeps = inferred
      .filter((i) => i.from === t.id && opts.infer === 'auto')
      .map((i) => i.on);
    const depends = [...new Set([...t.depends, ...additionalDeps])];
    const task: Task = {
      id: t.id,
      title: t.title,
      depends,
      agent: assignment.agent,
      skills: [],
      files: t.files,
      env: {},
      retries: 0,
      setup: [],
      prompt: t.prompt || t.title,
    };
    if (assignment.model) task.model = assignment.model;
    if (t.validation) {
      const { command, cwd } = extractValidationCwd(t.validation);
      task.validation = {
        command,
        'must-pass': true,
        ...(cwd !== undefined ? { cwd } : {}),
      };
      task.setup = inferSetupFromValidation(command);
    }
    return task;
  });

  const plan: Plan = {
    plan: { name: planName, version: 1, ...(parsed.description ? { description: parsed.description } : {}) },
    config: undefined,
    context: undefined,
    includes: [],
    tasks,
  };

  // Schema validation
  const parsedPlan = PlanSchema.safeParse(plan);
  if (!parsedPlan.success) {
    throw new PlanValidationError({
      message: parsedPlan.error.issues[0]?.message ?? 'invalid converted plan',
      issues: parsedPlan.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }

  const outPath = resolveOutPath(cwd, opts.out, planName);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stringifyYaml(parsedPlan.data));

  for (const i of inferred) {
    if (opts.infer === 'suggest') {
      warnings.push(`inferred dep ${i.from} → ${i.on} (confidence ${i.confidence}) — not applied (suggest mode)`);
    }
  }
  return { plan: parsedPlan.data, outPath, warnings, inferred };
}

function resolveOutPath(cwd: string, out: string | undefined, planName: string): string {
  const def = join(cwd, '.yaao', 'exec', `${planName}.yaml`);
  if (!out) return def;
  const abs = resolve(cwd, out);
  if (out.endsWith('.yaml') || out.endsWith('.yml')) return abs;
  return join(abs, `${planName}.yaml`);
}

/**
 * Convert one or many plans. When `input` is a directory of plans (not itself a
 * Spec Kit triplet), walks recursively and emits one execution YAML per plan
 * into `outDir` (default `.yaao/exec/`).
 */
export async function convertPlans(opts: ConvertOptions & { outDir?: string }): Promise<ConvertResult[]> {
  const cwd = resolve(opts.cwd);
  const discovered = discoverPlans({ cwd, input: opts.input });
  // If only one entry, behave like the single-plan path so users keep the
  // friendly "wrote .yaao/exec/<slug>.yaml" experience. We pass the discovered
  // plan's path explicitly so a single-plan directory input still works.
  if (discovered.length === 1) {
    const only = discovered[0];
    if (!only) return [];
    // Use the same slug-based output path as multi-plan mode, so directory and
    // single-file inputs are consistent: `<outRoot>/<slug>.yaml`.
    const outRoot = opts.outDir
      ? resolve(cwd, opts.outDir)
      : opts.out
        ? resolve(cwd, opts.out)
        : join(cwd, '.yaao', 'exec');
    const slugOut = opts.out && (opts.out.endsWith('.yaml') || opts.out.endsWith('.yml'))
      ? resolve(cwd, opts.out)
      : join(outRoot, `${only.slug}.yaml`);
    const single = await convertPlan({
      ...opts,
      input: only.path,
      out: slugOut,
      format: only.format,
    });
    return [single];
  }
  const results: ConvertResult[] = [];
  const outRoot = opts.outDir
    ? resolve(cwd, opts.outDir)
    : opts.out
      ? resolve(cwd, opts.out)
      : join(cwd, '.yaao', 'exec');
  for (const d of discovered) {
    const slugOut = join(outRoot, `${d.slug}.yaml`);
    // eslint-disable-next-line no-await-in-loop -- serial keeps stderr ordering sane
    const r = await convertPlan({
      ...opts,
      input: d.path,
      out: slugOut,
      // Force the format hint when we already know it (auto-detect would
      // otherwise re-classify a Spec Kit dir as a directory walk and loop).
      format: d.format,
    });
    results.push(r);
  }
  return results;
}

/**
 * Best-effort heuristic that turns a validation command into the shell-level
 * environment bootstrap it implies. Conservative: only emits commands that are
 * idempotent / no-op when already done (install, compose up, env copy with
 * `cp -n`). Users can override or extend by hand-editing the `setup:` list.
 */
/**
 * Pull a leading `cd <subdir> && ` off a validation command and surface it as
 * a structured `validation.cwd`. The planner skill recommends this shape for
 * monorepo packages so each task's validation runs in the right workspace;
 * the converter normalises it to the structured form so the lifecycle picks
 * the cwd up directly.
 */
export function extractValidationCwd(raw: string): { command: string; cwd?: string } {
  const m = raw.trim().match(/^cd\s+([^\s&;]+)\s*&&\s*(.+)$/s);
  if (m && m[1] && m[2]) return { command: m[2].trim(), cwd: m[1] };
  return { command: raw };
}

export function inferSetupFromValidation(cmd: string): string[] {
  const setup: string[] = [];
  const trimmed = cmd.trim();
  // Package manager → install, but only if there's a package.json to install
  // against. Scaffold/bootstrap tasks legitimately start from an empty
  // worktree and create package.json themselves; an unconditional install
  // would fail before the agent ever spawned.
  const pmMatch = trimmed.match(/^(pnpm|npm|yarn|bun)\b/);
  if (pmMatch) {
    const pm = pmMatch[1];
    setup.push(`if [ -f package.json ]; then ${pm} install; fi`);
  }
  // Prisma migrations need a live database and a populated .env — both are
  // declared as best-effort (already prefixed with `|| true`).
  if (/\bprisma\s+migrate\b/.test(trimmed)) {
    setup.push('docker compose up -d postgres 2>/dev/null || true');
    setup.push('cp -n .env.example .env 2>/dev/null || true');
  }
  return setup;
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([^a-z])/, 'p-$1')
    .slice(0, 60);
}
