import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  KNOWN_MODELS_ASOF,
  API_PROVIDER_MODELS,
  listKnownModels,
} from '../../../src/agents/known-models.js';
import { AGENT_NAMES } from '../../../src/config/types.js';

describe('F14.8 — KNOWN_MODELS static catalog', () => {
  it('every backend in AGENT_NAMES has a non-empty KNOWN_MODELS entry', () => {
    for (const a of AGENT_NAMES) {
      expect(KNOWN_MODELS[a].length).toBeGreaterThan(0);
      expect(KNOWN_MODELS_ASOF[a]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('claude-code carries opus/sonnet/haiku aliases', () => {
    const claude = KNOWN_MODELS['claude-code'];
    expect(claude.some((m) => m.alias === 'opus')).toBe(true);
    expect(claude.some((m) => m.alias === 'sonnet')).toBe(true);
    expect(claude.some((m) => m.alias === 'haiku')).toBe(true);
  });

  it('API_PROVIDER_MODELS has separate catalogs for anthropic / openai / openrouter', () => {
    expect(API_PROVIDER_MODELS.anthropic.length).toBeGreaterThan(0);
    expect(API_PROVIDER_MODELS.openai.length).toBeGreaterThan(0);
    expect(API_PROVIDER_MODELS.openrouter.length).toBeGreaterThan(0);
    // OpenRouter entries use vendor-prefixed identifiers
    expect(API_PROVIDER_MODELS.openrouter[0]?.name).toContain('/');
  });
});

describe('F14.8 — listKnownModels()', () => {
  it('returns one row per CLI agent + one row per api provider when unfiltered', () => {
    const rows = listKnownModels();
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('claude-code');
    expect(labels).toContain('cursor');
    expect(labels).toContain('copilot');
    expect(labels).toContain('codex');
    expect(labels).toContain('api/anthropic');
    expect(labels).toContain('api/openai');
    expect(labels).toContain('api/openrouter');
  });

  it('filters to a single agent', () => {
    const rows = listKnownModels({ agent: 'cursor' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.label).toBe('cursor');
  });

  it('filtering to api returns one row per provider', () => {
    const rows = listKnownModels({ agent: 'api' });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('api/anthropic');
    expect(labels).toContain('api/openai');
    expect(labels).toContain('api/openrouter');
  });

  it('every row has a non-empty asOf date', () => {
    for (const row of listKnownModels()) {
      expect(row.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
