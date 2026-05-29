import type { AgentName } from './backend.js';

/**
 * F14.8 — Static known-models catalog per backend.
 *
 * Surfaced via `yaao agents --models` and the `yaao_models` MCP tool so
 * a user can answer "what can I pass for `model:` on this backend?"
 * without grep-ing vendor docs. The catalog is **advisory, not
 * authoritative** — passing a model not listed here still works (the
 * vendor's error surfaces if the model is unsupported); the catalog
 * exists so users can discover what's *known to work*.
 *
 * Each backend ships a non-empty `KNOWN_MODELS` array plus a
 * `KNOWN_MODELS_ASOF` ISO date so users can see how stale the catalog
 * is. The convention is to bump `asOf` whenever the list changes,
 * even by one entry — staleness is a real failure mode (vendors ship
 * models on weekly cadences) and an explicit date lets users decide
 * whether to trust the list at a glance.
 */
export interface KnownModel {
  /** Canonical identifier the backend's CLI / API accepts. */
  name: string;
  /** Optional alias accepted by yaao's own resolution layer (e.g.
   * claude-code's `opus`/`sonnet`/`haiku`). */
  alias?: string;
  /** Short note: capability tier, deprecation status, vendor hint. */
  notes?: string;
}

export interface KnownModelsCatalog {
  agent: AgentName;
  asOf: string;
  models: KnownModel[];
}

const CLAUDE_CODE_MODELS: KnownModel[] = [
  { name: 'claude-opus-4-7', alias: 'opus', notes: 'highest-capability tier; Anthropic flagship' },
  { name: 'claude-sonnet-4-6', alias: 'sonnet', notes: 'balanced cost / capability; default tier' },
  { name: 'claude-haiku-4-5-20251001', alias: 'haiku', notes: 'fastest / cheapest tier' },
];

const CURSOR_MODELS: KnownModel[] = [
  { name: 'auto', notes: "let cursor-agent pick (default)" },
  { name: 'gpt-5', notes: 'OpenAI flagship via Cursor' },
  { name: 'claude-opus-4', notes: 'Anthropic flagship via Cursor' },
  { name: 'claude-sonnet-4', notes: 'Anthropic mid-tier via Cursor' },
];

const CODEX_MODELS: KnownModel[] = [
  { name: 'gpt-5', notes: 'OpenAI flagship via codex CLI' },
  { name: 'gpt-5-mini', notes: 'OpenAI cheap tier' },
  { name: 'o3', notes: 'OpenAI reasoning tier' },
  { name: 'o3-mini', notes: 'OpenAI reasoning cheap tier' },
];

const COPILOT_MODELS: KnownModel[] = [
  { name: 'gpt-5', notes: "GitHub's allow-list; subject to plan tier" },
  { name: 'gpt-4o', notes: "GitHub's allow-list" },
  { name: 'claude-opus-4-7', notes: "GitHub's allow-list (Anthropic via Copilot)" },
  { name: 'claude-sonnet-4-6', notes: "GitHub's allow-list" },
];

const ANTHROPIC_API_MODELS: KnownModel[] = [
  { name: 'claude-opus-4-7', notes: 'flagship; best for hard reasoning' },
  { name: 'claude-sonnet-4-6', notes: 'balanced default' },
  { name: 'claude-haiku-4-5-20251001', notes: 'fastest / cheapest' },
];

const OPENAI_API_MODELS: KnownModel[] = [
  { name: 'gpt-5', notes: 'OpenAI flagship' },
  { name: 'gpt-5-mini', notes: 'cheap tier; good for most tasks' },
  { name: 'gpt-4o', notes: 'previous-gen flagship; cheaper' },
  { name: 'gpt-4o-mini', notes: 'cheapest non-reasoning tier' },
  { name: 'o3', notes: 'reasoning model' },
  { name: 'o3-mini', notes: 'cheap reasoning model' },
];

const OPENROUTER_API_MODELS: KnownModel[] = [
  { name: 'anthropic/claude-opus-4-7', notes: 'OpenRouter routes vendor/model' },
  { name: 'anthropic/claude-sonnet-4-6' },
  { name: 'openai/gpt-5' },
  { name: 'openai/gpt-5-mini' },
  { name: 'openai/o3' },
];

const CATALOG_ASOF = '2026-05-29';

export const KNOWN_MODELS: Record<AgentName, KnownModel[]> = {
  'claude-code': CLAUDE_CODE_MODELS,
  cursor: CURSOR_MODELS,
  codex: CODEX_MODELS,
  copilot: COPILOT_MODELS,
  api: ANTHROPIC_API_MODELS, // when consulting "api" alone, default to anthropic
};

export const KNOWN_MODELS_ASOF: Record<AgentName, string> = {
  'claude-code': CATALOG_ASOF,
  cursor: CATALOG_ASOF,
  codex: CATALOG_ASOF,
  copilot: CATALOG_ASOF,
  api: CATALOG_ASOF,
};

/**
 * Per-provider catalogs for the `api` backend — surfaced separately
 * because a user picking `agent: api, provider: openrouter` needs a
 * different model list from `provider: anthropic`. The `KNOWN_MODELS.api`
 * shortcut above defaults to anthropic for compatibility with code that
 * keys on AgentName only.
 */
export const API_PROVIDER_MODELS: Record<'anthropic' | 'openai' | 'openrouter', KnownModel[]> = {
  anthropic: ANTHROPIC_API_MODELS,
  openai: OPENAI_API_MODELS,
  openrouter: OPENROUTER_API_MODELS,
};

/**
 * One row per backend (for CLI agents) or per `agent: api` provider
 * binding. The `label` field is what users see (e.g. `api/anthropic`)
 * and what the renderer groups on; `agent` is the AgentName so a
 * caller can filter against the same enum used elsewhere.
 */
export interface KnownModelsRow {
  agent: AgentName;
  /** Display label — "claude-code", "api/anthropic", etc. */
  label: string;
  asOf: string;
  models: KnownModel[];
}

export function listKnownModels(filter?: { agent?: AgentName }): KnownModelsRow[] {
  const out: KnownModelsRow[] = [];
  const agents: AgentName[] = filter?.agent
    ? [filter.agent]
    : ['claude-code', 'cursor', 'copilot', 'codex', 'api'];
  for (const a of agents) {
    if (a === 'api') {
      for (const [provider, models] of Object.entries(API_PROVIDER_MODELS) as [
        'anthropic' | 'openai' | 'openrouter',
        KnownModel[],
      ][]) {
        out.push({ agent: 'api', label: `api/${provider}`, asOf: CATALOG_ASOF, models });
      }
      continue;
    }
    out.push({ agent: a, label: a, asOf: CATALOG_ASOF, models: KNOWN_MODELS[a] });
  }
  return out;
}
