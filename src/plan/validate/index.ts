import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { YaaoConfig } from '../../config/types.js';
import type { ResolvedPlan, ResolvedTask } from '../schema/resolve.js';
import type { SourceMap, SourcePosition } from '../yaml/loader.js';
import type { AgentAvailability, ValidationIssue } from './types.js';
import { ALL_AVAILABLE } from './types.js';
import { findCycles } from './cycle.js';

export interface ValidateOptions {
  config: YaaoConfig;
  agents?: AgentAvailability;
  /** Directory used to resolve `prompt-ref` and `.yaao/skills/<name>/` paths. */
  cwd?: string;
  /** Promote warnings to errors (and report unreachable tasks). */
  strict?: boolean;
}

export function validatePlan(
  plan: ResolvedPlan,
  source: SourceMap,
  opts: ValidateOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const agents = opts.agents ?? ALL_AVAILABLE;
  const cwd = opts.cwd ?? process.cwd();

  if (plan.tasks.length === 0) {
    issues.push({
      severity: 'error',
      code: 'YAAO_PLAN_NO_TASKS',
      message: 'plan has no tasks',
    });
    return finalize(issues, opts.strict);
  }

  // ---- Duplicate task ids ---------------------------------------------------------
  const idCount = new Map<string, ResolvedTask[]>();
  for (const t of plan.tasks) {
    const arr = idCount.get(t.id) ?? [];
    arr.push(t);
    idCount.set(t.id, arr);
  }
  for (const [id, ts] of idCount) {
    if (ts.length > 1) {
      issues.push({
        severity: 'error',
        code: 'YAAO_PLAN_DUPLICATE_TASK_ID',
        message: `duplicate task id: '${id}' appears ${ts.length} times`,
        taskId: id,
        location: source.get(id),
      });
    }
  }

  // ---- Missing deps + self-deps ---------------------------------------------------
  const knownIds = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) {
    for (const dep of t.depends) {
      if (dep === t.id) {
        issues.push({
          severity: 'error',
          code: 'YAAO_PLAN_SELF_DEP',
          message: `task '${t.id}' depends on itself`,
          taskId: t.id,
          location: source.get(t.id),
        });
      } else if (!knownIds.has(dep)) {
        issues.push({
          severity: 'error',
          code: 'YAAO_PLAN_MISSING_DEP',
          message: `task '${t.id}' depends on missing task '${dep}'`,
          taskId: t.id,
          location: source.get(t.id),
        });
      }
    }
  }

  // ---- Cycles (Tarjan) ------------------------------------------------------------
  const graph = new Map<string, string[]>();
  for (const t of plan.tasks) {
    graph.set(
      t.id,
      t.depends.filter((d) => knownIds.has(d) && d !== t.id),
    );
  }
  for (const cycle of findCycles(graph)) {
    issues.push({
      severity: 'error',
      code: 'YAAO_PLAN_CYCLE',
      message: `cycle detected: ${cycle.join(' -> ')}`,
      location: cycle[0] ? source.get(cycle[0]) : undefined,
    });
  }

  // ---- Branch / worktree collisions -----------------------------------------------
  const seenBranches = new Map<string, string>();
  const seenWorktrees = new Map<string, string>();
  for (const t of plan.tasks) {
    if (seenBranches.has(t.branch)) {
      issues.push({
        severity: 'error',
        code: 'YAAO_PLAN_DUPLICATE_BRANCH',
        message: `tasks '${seenBranches.get(t.branch)}' and '${t.id}' both pin branch '${t.branch}'`,
        taskId: t.id,
        location: source.get(t.id),
      });
    } else {
      seenBranches.set(t.branch, t.id);
    }
    if (seenWorktrees.has(t.worktree)) {
      issues.push({
        severity: 'error',
        code: 'YAAO_PLAN_DUPLICATE_WORKTREE',
        message: `tasks '${seenWorktrees.get(t.worktree)}' and '${t.id}' both pin worktree '${t.worktree}'`,
        taskId: t.id,
        location: source.get(t.id),
      });
    } else {
      seenWorktrees.set(t.worktree, t.id);
    }
  }

  // ---- prompt-ref existence -------------------------------------------------------
  for (const t of plan.tasks) {
    const ref = t['prompt-ref'];
    if (!ref) continue;
    const planFile = source.get(t.id)?.file;
    const baseDir = planFile ? dirname(planFile) : cwd;
    const abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
    if (!existsSync(abs)) {
      issues.push({
        severity: 'error',
        code: 'YAAO_PLAN_PROMPT_REF_MISSING',
        message: `task '${t.id}' references missing prompt file: ${ref}`,
        taskId: t.id,
        location: source.get(t.id),
      });
    }
  }

  // ---- Agent enable / availability ------------------------------------------------
  for (const t of plan.tasks) {
    const agentEnabled = isAgentEnabled(opts.config, t.agent);
    if (!agentEnabled) {
      issues.push({
        severity: 'error',
        code: 'YAAO_PLAN_AGENT_DISABLED',
        message: `task '${t.id}' uses '${t.agent}' but agent is disabled in yaao.config.json`,
        taskId: t.id,
        location: source.get(t.id),
        hint: `set agents.${t.agent}.enabled = true (or change the task's agent)`,
      });
    } else if (!agents.available[t.agent]) {
      issues.push({
        severity: 'warning',
        code: 'YAAO_PLAN_AGENT_NOT_INSTALLED',
        message: `task '${t.id}' uses '${t.agent}' but the binary isn't on PATH`,
        taskId: t.id,
        location: source.get(t.id),
      });
    }

    if (t.agent === 'api' && t.api) {
      const provider = t.api.provider;
      const hasKey = agents.apiKeys[provider];
      if (!hasKey) {
        issues.push({
          severity: 'error',
          code: 'YAAO_PLAN_API_NO_KEY',
          message: `task '${t.id}' uses agent: api with provider '${provider}' but no API key resolves`,
          taskId: t.id,
          location: source.get(t.id),
          hint: `set the provider's api-key in .yaao/secrets.local.json or as an env var`,
        });
      }
    }
  }

  // ---- Skill resolution -----------------------------------------------------------
  for (const t of plan.tasks) {
    for (const skill of t.skills) {
      const skillDir = resolve(cwd, '.yaao', 'skills', skill);
      if (!existsSync(skillDir)) {
        issues.push({
          severity: 'warning',
          code: 'YAAO_PLAN_SKILL_UNKNOWN',
          message: `task '${t.id}' references skill '${skill}' but .yaao/skills/${skill}/ does not exist`,
          taskId: t.id,
          location: source.get(t.id),
        });
      }
    }
  }

  // ---- merge: none with deps ------------------------------------------------------
  const dependents = new Map<string, string[]>();
  for (const t of plan.tasks) {
    for (const d of t.depends) {
      const arr = dependents.get(d) ?? [];
      arr.push(t.id);
      dependents.set(d, arr);
    }
  }
  for (const t of plan.tasks) {
    if (t.merge.strategy === 'none') {
      const ds = dependents.get(t.id) ?? [];
      if (ds.length > 0) {
        issues.push({
          severity: 'warning',
          code: 'YAAO_PLAN_MERGE_NONE_WITH_DEPS',
          message: `task '${t.id}' uses merge: none but is depended on by ${ds.length} task(s); downstream may not see its work`,
          taskId: t.id,
          location: source.get(t.id),
        });
      }
    }
  }

  // ---- Fan-out width --------------------------------------------------------------
  const widths = computeLayerWidths(plan.tasks);
  const cap = plan.config['max-parallel'] * 4;
  for (const w of widths) {
    if (w > cap) {
      issues.push({
        severity: 'warning',
        code: 'YAAO_PLAN_FAN_OUT_HIGH',
        message: `DAG layer width ${w} exceeds max-parallel*4 (${cap}); plan may be wider than intended`,
      });
      break;
    }
  }

  // ---- Strict-mode unreachable-task check -----------------------------------------
  if (opts.strict) {
    const reachable = new Set<string>();
    for (const t of plan.tasks) {
      if (t.depends.length > 0) for (const d of t.depends) reachable.add(d);
    }
    for (const t of plan.tasks) {
      if (t.depends.length === 0 && !dependents.get(t.id)?.length && !reachable.has(t.id) && plan.tasks.length > 1) {
        issues.push({
          severity: 'warning',
          code: 'YAAO_PLAN_UNREACHABLE_TASK',
          message: `task '${t.id}' has no incoming or outgoing edges`,
          taskId: t.id,
          location: source.get(t.id),
        });
      }
    }
  }

  return finalize(issues, opts.strict);
}

function isAgentEnabled(cfg: YaaoConfig, name: string): boolean {
  if (name === 'api') {
    return Object.keys(cfg.agents.api.providers).length > 0;
  }
  const entry = (cfg.agents as Record<string, { enabled?: boolean } | undefined>)[name];
  return entry?.enabled !== false;
}

function computeLayerWidths(tasks: ResolvedTask[]): number[] {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const layer = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id) as number;
    if (seen.has(id)) return 0; // cycle; cycles are reported separately
    seen.add(id);
    const t = idToTask.get(id);
    if (!t || t.depends.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const d of t.depends) {
      const dl = compute(d, seen);
      if (dl + 1 > max) max = dl + 1;
    }
    layer.set(id, max);
    return max;
  };
  for (const t of tasks) compute(t.id, new Set());
  const widths = new Map<number, number>();
  for (const l of layer.values()) widths.set(l, (widths.get(l) ?? 0) + 1);
  return [...widths.values()];
}

function finalize(issues: ValidationIssue[], strict: boolean | undefined): ValidationIssue[] {
  const promoted = strict
    ? issues.map((i): ValidationIssue => (i.severity === 'warning' ? { ...i, severity: 'error' } : i))
    : issues;
  return promoted.slice().sort((a, b) => compareIssue(a, b));
}

function compareIssue(a: ValidationIssue, b: ValidationIssue): number {
  return (
    cmp(loc(a)?.file ?? '', loc(b)?.file ?? '') ||
    (loc(a)?.line ?? 0) - (loc(b)?.line ?? 0) ||
    (loc(a)?.col ?? 0) - (loc(b)?.col ?? 0) ||
    cmp(a.code, b.code)
  );
}

function loc(i: ValidationIssue): SourcePosition | undefined {
  return i.location;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { ALL_AVAILABLE } from './types.js';
export type { AgentAvailability, ValidationIssue } from './types.js';
