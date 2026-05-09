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
  };
}

export interface ResolvedPlanContext {
  'ctx-sys': {
    enabled: boolean;
    'require-query': boolean;
  };
}

export type ResolvedTask = Task & {
  branch: string;
  worktree: string;
  merge: 'auto' | 'pr' | 'manual' | 'none';
  retries: number;
};

export interface ResolveOptions {
  config: YaaoConfig;
}

export function resolvePlan(plan: Plan, opts: ResolveOptions): ResolvedPlan {
  const cfg = opts.config;
  const planCfg = plan.config ?? {};
  const planMerge = planCfg.merge ?? {};
  const ctxSys = plan.context?.['ctx-sys'] ?? {};

  const resolvedConfig: ResolvedPlanConfig = {
    'base-branch': planCfg['base-branch'] ?? cfg.defaults['base-branch'],
    'max-parallel': planCfg['max-parallel'] ?? cfg.defaults['max-parallel'],
    'worktree-root': planCfg['worktree-root'] ?? cfg.defaults['worktree-root'],
    merge: {
      strategy: planMerge.strategy ?? cfg.merge.strategy,
      'on-conflict': planMerge['on-conflict'] ?? cfg.merge['on-conflict'],
    },
  };

  const resolvedContext: ResolvedPlanContext = {
    'ctx-sys': {
      enabled: ctxSys.enabled ?? cfg['ctx-sys'].enabled,
      'require-query': ctxSys['require-query'] ?? cfg['ctx-sys']['require-query'],
    },
  };

  const tasks: ResolvedTask[] = plan.tasks.map((t) => {
    const branch = t.branch ?? `${plan.plan.name}/${t.id}`;
    const worktree = t.worktree ?? `${resolvedConfig['worktree-root']}/${plan.plan.name}/${t.id}`;
    return {
      ...t,
      branch,
      worktree,
      merge: t.merge ?? resolvedConfig.merge.strategy,
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
