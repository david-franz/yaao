import type { AgentName, YaaoConfig } from './schema.js';
import { AGENT_NAMES } from './schema.js';

/**
 * Single source of truth for "is this agent enabled in the user's config?"
 *
 * - For CLI agents (`claude-code`, `cursor`, `copilot`, `codex`) the flag is
 *   `agents.<name>.enabled` (default true; explicit `false` disables).
 * - For the `api` backend there's no explicit enable toggle — it's "enabled"
 *   iff the user has configured at least one provider with an `api-key`.
 *
 * Used by the converter's agent-assignment fallback, by the planner's
 * config-aware backend resolver, by the run-time validation gate, by
 * `yaao skills install` emitter filtering, and by the `yaao agents` strict
 * mode. Keeping the logic in one place means a future change (e.g. an
 * explicit `agents.api.enabled` flag) only touches one file.
 */
export function isAgentEnabled(cfg: YaaoConfig, name: AgentName | string): boolean {
  if (name === 'api') {
    return Object.keys(cfg.agents.api.providers).length > 0;
  }
  const entry = (cfg.agents as unknown as Record<string, { enabled?: boolean } | undefined>)[name];
  return entry?.enabled !== false;
}

/**
 * List the agents the user has enabled, in the canonical order
 * (`claude-code, cursor, copilot, codex, api`). Used by the planner skill's
 * `enabled-agents` input and by the converter's fallback walk so we route to
 * a real backend rather than the schema's default-which-might-be-disabled.
 */
export function enabledAgents(cfg: YaaoConfig): AgentName[] {
  return AGENT_NAMES.filter((n) => isAgentEnabled(cfg, n));
}

/**
 * Pick the first enabled agent that we can actually spawn — prefers the
 * workspace `defaults.agent` when it's enabled, otherwise walks the enabled
 * list in canonical order. Returns `undefined` only when the user has
 * disabled every agent (caller should raise `YAAO_NO_ENABLED_AGENTS`).
 *
 * Callers that have a specific candidate to honor first (an `--agent` flag,
 * a task's explicit `agent:` field, a `plan.agent` config block) should
 * check `isAgentEnabled` on that candidate first and only fall back to
 * `pickEnabledAgent` when the candidate is unavailable.
 */
export function pickEnabledAgent(cfg: YaaoConfig): AgentName | undefined {
  const preferred = cfg.defaults.agent;
  if (isAgentEnabled(cfg, preferred)) return preferred;
  const enabled = enabledAgents(cfg);
  return enabled[0];
}
