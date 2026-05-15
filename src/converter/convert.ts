import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { YaaoConfig } from '../config/types.js';
import { PlanSchema, type Plan, type Task } from '../plan/schema/plan.js';
import { loadInputPlan, type PlanInputFormat } from './load-plan.js';
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
      prompt: t.prompt || t.title,
    };
    if (assignment.model) task.model = assignment.model;
    if (t.validation) task.validation = { command: t.validation, 'must-pass': true };
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

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([^a-z])/, 'p-$1')
    .slice(0, 60);
}
