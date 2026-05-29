import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { YaaoConfig } from '../config/types.js';
import { PlanSchema, type Plan, type Task } from '../plan/schema/plan.js';
import { loadInputPlan, discoverPlans, type PlanInputFormat } from './load-plan.js';
import { assignAgent, type AgentRule } from './assign-agent.js';
import { inferDependencies, type InferMode } from './infer-deps.js';
import { isNarrowDag } from '../plan/dag.js';
import { PlanValidationError } from '../log/errors.js';
import type { ParsedPlan } from '../planner/markdown.js';

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
  /** When set, written verbatim into the generated YAML as `plan.featureBranch`.
   * Omitted → field absent (the plan author can add it later by hand, or the
   * run can override via runtime arg). We deliberately do not infer from the
   * current git branch or workspace config — featureBranch is a per-plan
   * authoring decision. */
  featureBranch?: string;
}

export interface ConvertResult {
  plan: Plan;
  outPath: string;
  /** Whether outPath existed before this run — lets callers distinguish `created` vs `overwrote`. */
  outAction: 'created' | 'overwrote';
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
      // Keep in sync with TaskSchema's retries default — one retry catches
      // transient validation flakes (test teardown, etc.) without burning
      // many extra tokens on truly broken tasks.
      retries: 1,
      setup: [],
      prompt: t.prompt || t.title,
    };
    if (assignment.model) task.model = assignment.model;
    if (t.validation) {
      const { command, cwd: explicitCwd } = extractValidationCwd(t.validation);
      // Fall back to the deepest directory shared by all `files:` entries when
      // the validation command didn't already specify a cwd. In a monorepo this
      // routes `pnpm build` / `pnpm test` to the task's actual workspace
      // instead of the root, where parallel siblings would otherwise clobber
      // each other. Pure heuristic — explicit cwd or `cd …` prefix always
      // wins.
      const inferredCwd = explicitCwd ?? inferCwdFromFiles(t.files);
      task.validation = {
        command,
        'must-pass': true,
        ...(inferredCwd !== undefined ? { cwd: inferredCwd } : {}),
      };
      task.setup = inferSetupFromValidation(command);
    }
    return task;
  });

  // F14.5 — Propagate spec.md and plan.md content (when the source was a
  // Spec Kit triplet) into `plan.context`. Lifecycle inlines this into
  // every task's prompt at run time, token-budgeted by
  // `config.context.plan-context-budget`. A converter that's seeing a
  // markdown plan (no spec/plan side files) leaves the field empty.
  const planContext = buildPlanContext(parsed);
  const plan: Plan = {
    plan: {
      name: planName,
      version: 1,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(opts.featureBranch ? { featureBranch: opts.featureBranch } : {}),
      ...(planContext !== undefined ? { context: planContext } : {}),
    },
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
  const outAction: 'created' | 'overwrote' = existsSync(outPath) ? 'overwrote' : 'created';
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stringifyYaml(parsedPlan.data));

  for (const i of inferred) {
    if (opts.infer === 'suggest') {
      warnings.push(`inferred dep ${i.from} → ${i.on} (confidence ${i.confidence}) — not applied (suggest mode)`);
    }
  }
  if (isNarrowDag(parsedPlan.data.tasks)) {
    // Strict chain wider than two tasks — the plan leaves yaao's parallelism
    // on the table. Surface as a warning so the author notices, without
    // refusing the conversion: a genuinely-serial plan (e.g. a migration
    // sequence) is a valid choice.
    warnings.push(
      `YAAO_PLAN_NARROW_DAG: plan is fully sequential (${parsedPlan.data.tasks.length} tasks in a chain); ` +
        `consider whether docs, tests, or independent subsystems could be siblings of the implementation task ` +
        `instead of waiting on it.`,
    );
  }
  return { plan: parsedPlan.data, outPath, outAction, warnings, inferred };
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

/**
 * Standard monorepo layout roots. When the inferred prefix starts with one of
 * these, we cap at two segments (e.g. `apps/web`, not `apps/web/src`) so the
 * cwd lands at the workspace root where `package.json` lives.
 */
const MONOREPO_ROOTS = new Set(['apps', 'packages', 'services', 'libs']);

/**
 * Pick a `validation.cwd` from a task's declared file list when the command
 * didn't already specify one. Only infers when the file list lives entirely
 * under a known monorepo workspace root (apps/<pkg>, packages/<pkg>,
 * services/<pkg>, libs/<pkg>) — in that case the cwd is capped at
 * `<root>/<pkg>` (the workspace root, where package.json lives).
 *
 * For non-monorepo layouts (flat Python projects with `src/foo/`, `tests/`,
 * etc.) we deliberately return undefined and let validation run from the
 * worktree root. Inferring "deepest common prefix" there is harmful:
 * `python -m src.tax_calculator` must run where `src/` is a sibling, not
 * inside `src/tax_calculator/`; `pytest tests/` needs `tests/` to be a
 * subdir of cwd, not for cwd to BE `tests/`. The planner skill is told to
 * use `cd <dir> &&` in validation if a non-root cwd is genuinely needed.
 */
export function inferCwdFromFiles(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  // Normalise: drop trailing slashes, split on `/`, ignore empty leading segs.
  const splits = files.map((f) =>
    f
      .trim()
      .replace(/\/+$/, '')
      .split('/')
      .filter((seg) => seg.length > 0),
  );
  if (splits.some((s) => s.length < 2)) return undefined; // some file at repo root
  // Only infer when EVERY file lives under the same known monorepo layout
  // root (apps/X/..., packages/X/..., etc.). This is the only case where
  // "the deepest common dir" reliably maps to a workspace root where
  // validation commands should run.
  const first = splits[0]!;
  if (first[0] === undefined || !MONOREPO_ROOTS.has(first[0])) return undefined;
  const workspaceRoot = first[1];
  if (workspaceRoot === undefined) return undefined;
  for (let i = 1; i < splits.length; i++) {
    const cur = splits[i]!;
    if (cur[0] !== first[0] || cur[1] !== workspaceRoot) return undefined;
  }
  let prefixLen = first.length - 1; // ignore the filename segment
  for (let i = 1; i < splits.length; i++) {
    const cur = splits[i]!;
    const maxShared = Math.min(prefixLen, cur.length - 1);
    let shared = 0;
    while (shared < maxShared && first[shared] === cur[shared]) shared += 1;
    prefixLen = shared;
    if (prefixLen === 0) return undefined;
  }
  if (prefixLen === 0) return undefined;
  // For standard monorepo layouts the workspace name is the second segment.
  // If files only share the layout root (e.g. `apps/api/...` vs `apps/web/...`
  // collapse to just `apps`), that's not a useful cwd — bail out.
  if (first[0] !== undefined && MONOREPO_ROOTS.has(first[0])) {
    if (prefixLen < 2) return undefined;
    if (prefixLen > 2) prefixLen = 2;
  }
  return first.slice(0, prefixLen).join('/');
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

/**
 * F14.5 — Compose `plan.context` from the source Spec Kit triplet's
 * `spec.md` + `plan.md` bodies. Returns undefined when neither is
 * present (the markdown-plan path); returns a concatenated string with
 * H2 separators when one or both are. Lifecycle reads this and inlines
 * into every task's prompt under a "Plan context" preamble.
 */
function buildPlanContext(parsed: ParsedPlan): string | undefined {
  const blocks: string[] = [];
  if (parsed.specContent && parsed.specContent.trim().length > 0) {
    blocks.push(`## From spec.md\n\n${parsed.specContent.trim()}`);
  }
  if (parsed.planContent && parsed.planContent.trim().length > 0) {
    blocks.push(`## From plan.md\n\n${parsed.planContent.trim()}`);
  }
  if (blocks.length === 0) return undefined;
  return blocks.join('\n\n');
}
