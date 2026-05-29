import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import { fakeResolved } from '../../helpers/plan.js';
import type { AgentAvailability } from '../../../src/plan/validate/types.js';

const AGENTS_WITH_KEYS: AgentAvailability = {
  available: { 'claude-code': true, cursor: true, copilot: true, codex: true, api: true },
  apiKeys: { anthropic: true, openai: true, openrouter: true },
};

/**
 * F14.6 removed the YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED rule that F14.3
 * added — OpenAI and OpenRouter providers now ship as working
 * implementations. The remaining validation surface for api-backend
 * plans is YAAO_PLAN_API_NO_KEY, which applies symmetrically across all
 * three providers.
 */
describe('F14.6 — openai/openrouter providers no longer fail validation', () => {
  it('provider: openai passes validation when key is resolvable', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { openai: { 'api-key': 'sk-test' } } } },
    });
    const { plan, source } = fakeResolved({
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'api',
          prompt: 'hi',
          api: { provider: 'openai', model: 'gpt-4o-mini' },
        },
      ],
    });
    const issues = validatePlan(plan, source, { config, agents: AGENTS_WITH_KEYS });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeUndefined();
    expect(issues.find((i) => i.severity === 'error')).toBeUndefined();
  });

  it('provider: openrouter passes validation when key is resolvable', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { openrouter: { 'api-key': 'sk-test' } } } },
    });
    const { plan, source } = fakeResolved({
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'api',
          prompt: 'hi',
          api: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' },
        },
      ],
    });
    const issues = validatePlan(plan, source, { config, agents: AGENTS_WITH_KEYS });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeUndefined();
    expect(issues.find((i) => i.severity === 'error')).toBeUndefined();
  });

  it('YAAO_PLAN_API_NO_KEY still fires for any provider without a resolvable key', () => {
    const config = ConfigSchema.parse({ version: 1 });
    const { plan, source } = fakeResolved({
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'api',
          prompt: 'hi',
          api: { provider: 'openai', model: 'gpt-4o-mini' },
        },
      ],
    });
    const noKeyAgents: AgentAvailability = {
      ...AGENTS_WITH_KEYS,
      apiKeys: { anthropic: false, openai: false, openrouter: false },
    };
    const issues = validatePlan(plan, source, { config, agents: noKeyAgents });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_NO_KEY')).toBeDefined();
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeUndefined();
  });
});
