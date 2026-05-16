import type { YaaoConfig, AgentName } from '../config/types.js';
import type { ParsedTask } from '../planner/markdown.js';

export interface MatchPredicate {
  'title-regex'?: string;
  'id-regex'?: string;
  'files-glob'?: string;
  'prompt-contains'?: string;
  any?: boolean;
}

export interface AgentRule {
  match: MatchPredicate;
  agent: AgentName;
  model?: string;
}

export interface AssignOptions {
  config: YaaoConfig;
  /** User-defined rules. Falls back to built-ins when absent. */
  rules?: AgentRule[];
  /** Disable the built-in default catch-all rules. */
  disableBuiltins?: boolean;
  /** True if API providers are available with resolvable keys (for fallback decisions). */
  apiAvailable?: boolean;
}

export interface AssignmentResult {
  agent: AgentName;
  model?: string;
  reason: string;
  /** When the rule asked for `api` but no key was resolvable, we demote to defaults. */
  demoted?: boolean;
}

export const BUILTIN_AGENT_RULES: AgentRule[] = [
  { match: { 'title-regex': '(?i)test|spec|e2e' }, agent: 'codex' },
  { match: { 'title-regex': '(?i)ui|frontend|page|component' }, agent: 'cursor' },
  { match: { 'files-glob': 'infra/**' }, agent: 'claude-code', model: 'opus' },
];

export function assignAgent(task: ParsedTask, opts: AssignOptions): AssignmentResult {
  // 1) Explicit suggestion from the plan author wins.
  if (task.agent) {
    return finalizeApiFallback(
      finalizeEnabledFallback(
        withResolvedModel(
          {
            agent: task.agent as AgentName,
            ...(task.model !== undefined ? { model: task.model } : {}),
            reason: 'task suggested agent',
          },
          opts,
        ),
        opts,
      ),
      opts,
    );
  }

  // 2) Rule precedence: user rules → built-ins (unless disabled) → defaults.
  const rules = [...(opts.rules ?? []), ...(opts.disableBuiltins ? [] : BUILTIN_AGENT_RULES)];
  for (const rule of rules) {
    if (matches(rule.match, task)) {
      // Skip rules that point at a disabled agent so we don't silently route work
      // to a backend the user hasn't set up. Falls through to the next matching
      // rule, or eventually the project default.
      if (!isAgentEnabled(rule.agent, opts.config)) continue;
      return finalizeApiFallback(
        withResolvedModel(
          {
            agent: rule.agent,
            ...(rule.model !== undefined ? { model: rule.model } : {}),
            reason: `matched rule ${describeRule(rule.match)}`,
          },
          opts,
        ),
        opts,
      );
    }
  }

  // 3) Project default. defaults.model is the final fallback when no per-agent
  // default-model is set for the chosen agent.
  return withResolvedModel(
    {
      agent: opts.config.defaults.agent,
      model: opts.config.defaults.model,
      reason: 'project default',
    },
    opts,
  );
}

/**
 * Resolution order for a task's model when one isn't explicitly stated:
 *
 *   task.model (caller-provided) →
 *   agents.<assigned>.default-model →
 *   defaults.model
 *
 * Lets a project say "claude-code runs sonnet by default" without scattering
 * the choice across every task in the plan.
 */
function withResolvedModel(r: AssignmentResult, opts: AssignOptions): AssignmentResult {
  if (r.model !== undefined) return r;
  const agentEntry = (
    opts.config.agents as unknown as Record<string, { 'default-model'?: string } | undefined>
  )[r.agent];
  const perAgent = agentEntry?.['default-model'];
  if (perAgent !== undefined) return { ...r, model: perAgent };
  return { ...r, model: opts.config.defaults.model };
}

/**
 * `agents.<name>.enabled` is the user's "I have this CLI set up" switch. If a
 * task or user rule explicitly asks for a disabled agent, we honor the user's
 * config and demote to the project default rather than queuing work that will
 * fail at preflight. `api` doesn't have an `enabled` flag — its availability is
 * decided by whether a provider key is resolvable (see finalizeApiFallback).
 */
function isAgentEnabled(agent: AgentName, config: YaaoConfig): boolean {
  if (agent === 'api') return true;
  const entry = (config.agents as unknown as Record<string, { enabled?: boolean } | undefined>)[agent];
  return entry?.enabled !== false;
}

function finalizeEnabledFallback(r: AssignmentResult, opts: AssignOptions): AssignmentResult {
  if (isAgentEnabled(r.agent, opts.config)) return r;
  return {
    agent: opts.config.defaults.agent,
    model: opts.config.defaults.model,
    reason: `${r.reason}; demoted from ${r.agent} (disabled in config)`,
    demoted: true,
  };
}

function matches(predicate: MatchPredicate, task: ParsedTask): boolean {
  if (predicate.any) return true;
  if (predicate['title-regex'] && buildRegex(predicate['title-regex']).test(task.title)) return true;
  if (predicate['id-regex'] && buildRegex(predicate['id-regex']).test(task.id)) return true;
  if (predicate['files-glob']) {
    const re = globToRegex(predicate['files-glob']);
    if (task.files.some((f) => re.test(f))) return true;
  }
  if (
    predicate['prompt-contains'] &&
    task.prompt.toLowerCase().includes(predicate['prompt-contains'].toLowerCase())
  ) {
    return true;
  }
  return false;
}

/**
 * JavaScript's RegExp doesn't speak inline flag groups. We translate a leading
 * `(?i)` into a JS `i` flag so the rule format documented in F10.5 still works.
 */
function buildRegex(pattern: string): RegExp {
  const ciMatch = pattern.match(/^\(\?i\)(.*)$/s);
  if (ciMatch && ciMatch[1] !== undefined) return new RegExp(ciMatch[1], 'i');
  return new RegExp(pattern);
}

function describeRule(p: MatchPredicate): string {
  for (const k of ['title-regex', 'id-regex', 'files-glob', 'prompt-contains'] as const) {
    if (p[k]) return `${k}="${p[k]}"`;
  }
  if (p.any) return 'any';
  return 'unknown';
}

function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '.') {
      re += '\\.';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function finalizeApiFallback(r: AssignmentResult, opts: AssignOptions): AssignmentResult {
  if (r.agent !== 'api') return r;
  if (opts.apiAvailable !== false) return r;
  return {
    agent: opts.config.defaults.agent,
    model: opts.config.defaults.model,
    reason: `${r.reason}; demoted from api (no provider key)`,
    demoted: true,
  };
}
