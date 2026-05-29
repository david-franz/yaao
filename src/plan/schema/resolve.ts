import type { YaaoConfig } from '../../config/types.js';
import type { Plan, Task } from './plan.js';

/**
 * A `Plan` after default resolution. Every field needed for execution is concrete.
 * Fields like `prompt-ref` remain optional because they're alternates, not defaults.
 */
export interface ResolvedPlan {
  plan: Plan['plan'];
  config: ResolvedPlanConfig;
  context: ResolvedPlanContext;
  includes: string[];
  tasks: ResolvedTask[];
}

export interface ResolvedPlanConfig {
  'base-branch': string;
  'max-parallel': number;
  'worktree-root': string;
  merge: {
    strategy: 'auto' | 'pr' | 'manual';
    'on-conflict': 'manual' | 'agent';
    history: 'merge' | 'rebase';
  };
  context: {
    'per-dep-budget'?: number;
    'total-budget'?: number;
    'plan-context-budget'?: number;
    /**
     * F16.3 — Optional override for which handoff sections appear in
     * each task's `context.md`. When undefined, all four (`prompt`,
     * `validation`, `commits`, `diff`) are emitted. Set to `[]` to
     * reproduce the pre-F16.3 artifact byte-for-byte.
     */
    include?: ('prompt' | 'validation' | 'commits' | 'diff')[];
  };
  hooks: {
    'post-task': { command: string; cwd?: string; 'must-pass': boolean }[];
  };
}

export interface ResolvedPlanContext {
  'ctx-sys': {
    enabled: boolean;
    'require-query': boolean;
  };
}

export interface ResolvedTaskMerge {
  strategy: 'auto' | 'pr' | 'manual' | 'none';
  into?: string;
  when: 'completed' | 'manual';
  'create-if-missing': boolean;
}

export type ResolvedTask = Omit<Task, 'merge'> & {
  branch: string;
  worktree: string;
  merge: ResolvedTaskMerge;
  retries: number;
  /** Resolved permission mode (task → config default fallback). Always set. */
  permissions: 'ask' | 'allow-edits' | 'allow-all';
};

export interface ResolveOptions {
  config: YaaoConfig;
}

export function resolvePlan(plan: Plan, opts: ResolveOptions): ResolvedPlan {
  const cfg = opts.config;
  const planCfg = plan.config ?? {};
  const planMerge = planCfg.merge ?? {};
  const ctxSys = plan.context?.['ctx-sys'] ?? {};

  const planContext = planCfg.context ?? {};
  const resolvedConfig: ResolvedPlanConfig = {
    'base-branch': planCfg['base-branch'] ?? cfg.defaults['base-branch'],
    'max-parallel': planCfg['max-parallel'] ?? cfg.defaults['max-parallel'],
    'worktree-root': planCfg['worktree-root'] ?? cfg.defaults['worktree-root'],
    merge: {
      strategy: planMerge.strategy ?? cfg.merge.strategy,
      'on-conflict': planMerge['on-conflict'] ?? cfg.merge['on-conflict'],
      history: planMerge.history ?? cfg.merge.history,
    },
    context: {
      ...(planContext['per-dep-budget'] !== undefined
        ? { 'per-dep-budget': planContext['per-dep-budget'] }
        : {}),
      ...(planContext['total-budget'] !== undefined
        ? { 'total-budget': planContext['total-budget'] }
        : {}),
      ...(planContext['plan-context-budget'] !== undefined
        ? { 'plan-context-budget': planContext['plan-context-budget'] }
        : {}),
      ...(planContext.include !== undefined
        ? { include: planContext.include }
        : {}),
    },
    hooks: {
      'post-task': planCfg.hooks?.['post-task'] ?? [],
    },
  };

  const resolvedContext: ResolvedPlanContext = {
    'ctx-sys': {
      enabled: ctxSys.enabled ?? cfg['ctx-sys'].enabled,
      'require-query': ctxSys['require-query'] ?? cfg['ctx-sys']['require-query'],
    },
  };

  // F16.1 — Default branch namespacing. When `plan.featureBranch` is
  // set, each task's default branch lives under a namespace derived
  // from the featureBranch so two concurrent runs against distinct
  // feature branches have disjoint task-branch namespaces by
  // construction.
  //
  // git's ref store treats slashes as directory separators, so we
  // can't naively use `${featureBranch}/${task.id}`: if featureBranch
  // is `feature/alpha`, then both `feature/alpha` (the branch) and
  // `feature/alpha/<task>` (a would-be task branch) want to live at
  // the same path and git rejects the create with `cannot lock ref ...
  // 'refs/heads/feature/alpha' exists`. We sidestep this by replacing
  // every `/` in the featureBranch with `-` to form the task-branch
  // namespace: `feature/alpha` → ns `feature-alpha` → task branches
  // `feature-alpha/api`, `feature-alpha/ui`. The featureBranch ref
  // itself is unchanged.
  //
  // Without featureBranch we fall back to the historical
  // `${plan.name}/${task.id}` shape (backward-compatible). Tasks with
  // an explicit `branch:` field are unaffected — the override path is
  // never namespaced.
  const featureBranchForNs = plan.plan.featureBranch;
  const branchNamespace = featureBranchForNs
    ? featureBranchForNs.replace(/\//g, '-')
    : plan.plan.name;
  const tasks: ResolvedTask[] = plan.tasks.map((t) => {
    const branch = t.branch ?? `${branchNamespace}/${t.id}`;
    const worktree = t.worktree ?? `${resolvedConfig['worktree-root']}/${plan.plan.name}/${t.id}`;
    const merge = resolveTaskMerge(t.merge, resolvedConfig.merge.strategy);
    const { merge: _drop, ...rest } = t;
    void _drop;
    return {
      ...rest,
      branch,
      worktree,
      merge,
      permissions: t.permissions ?? cfg.defaults.permissions,
    };
  });

  return {
    plan: plan.plan,
    config: resolvedConfig,
    context: resolvedContext,
    includes: plan.includes,
    tasks,
  };
}

/**
 * Normalize the per-task merge directive into a consistent object form. Accepts
 * either the shorthand strategy string or the full object; falls back to the
 * plan-level strategy when the task says nothing.
 */
/**
 * Single point of truth for "where does this plan's work live, and where does
 * it land?" Every consumer (runner, lifecycle, inspect, validate) reads branch
 * policy through this helper instead of poking at `plan.config['base-branch']`
 * + `plan.plan.featureBranch` independently, so the precedence rules stay in
 * one place: `featureBranch = plan.plan.featureBranch` (or absent → tasks
 * merge straight into base-branch), `baseBranch = plan.config['base-branch']`
 * (resolved from workspace defaults at load time).
 */
export interface BranchPolicy {
  baseBranch: string;
  featureBranch?: string;
  /** Auto-merge target: featureBranch when set, otherwise baseBranch. */
  mergeTarget: string;
}

export function resolveBranchPolicy(plan: ResolvedPlan): BranchPolicy {
  const baseBranch = plan.config['base-branch'];
  const featureBranch = plan.plan.featureBranch;
  return {
    baseBranch,
    ...(featureBranch !== undefined ? { featureBranch } : {}),
    mergeTarget: featureBranch ?? baseBranch,
  };
}

function resolveTaskMerge(
  raw: Task['merge'],
  planStrategy: 'auto' | 'pr' | 'manual',
): ResolvedTaskMerge {
  if (raw === undefined) {
    return { strategy: planStrategy, when: 'completed', 'create-if-missing': true };
  }
  if (typeof raw === 'string') {
    return { strategy: raw, when: 'completed', 'create-if-missing': true };
  }
  return {
    strategy: raw.strategy ?? planStrategy,
    ...(raw.into !== undefined ? { into: raw.into } : {}),
    when: raw.when ?? 'completed',
    'create-if-missing': raw['create-if-missing'] ?? true,
  };
}
