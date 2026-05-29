import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../../src/config/schema.js';

describe('F14.8 — plan.agent / plan.model / plan.api config block', () => {
  it('parses plan.agent + plan.model + plan.api.provider together', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'cursor' },
      plan: {
        agent: 'api',
        model: 'claude-opus-4-7',
        api: { provider: 'anthropic' },
      },
    });
    expect(config.plan.agent).toBe('api');
    expect(config.plan.model).toBe('claude-opus-4-7');
    expect(config.plan.api?.provider).toBe('anthropic');
  });

  it('rejects an unknown plan.api.provider value', () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        plan: { api: { provider: 'unknown-vendor' } },
      }),
    ).toThrow();
  });

  it('rejects an unknown plan.agent enum value', () => {
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        plan: { agent: 'gemini' },
      }),
    ).toThrow();
  });

  it('all three fields are optional', () => {
    const config = ConfigSchema.parse({ version: 1, plan: { format: 'markdown' } });
    expect(config.plan.agent).toBeUndefined();
    expect(config.plan.model).toBeUndefined();
    expect(config.plan.api).toBeUndefined();
  });
});
