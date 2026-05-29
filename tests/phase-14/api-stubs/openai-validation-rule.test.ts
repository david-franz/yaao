import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import { fakeResolved } from '../../helpers/plan.js';
import type { AgentAvailability } from '../../../src/plan/validate/types.js';

const AGENTS: AgentAvailability = {
  available: { 'claude-code': true, cursor: true, copilot: true, codex: true, api: true },
  apiKeys: { anthropic: true, openai: true, openrouter: true },
};

describe('F14.3 — YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED for openai/openrouter', () => {
  it('flags provider: openai as an error', () => {
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
    const issues = validatePlan(plan, source, { config, agents: AGENTS });
    const issue = issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.taskId).toBe('a');
  });

  it('flags provider: openrouter as an error', () => {
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
    const issues = validatePlan(plan, source, { config, agents: AGENTS });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeDefined();
  });

  it('does NOT flag provider: anthropic', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { anthropic: { 'api-key': 'sk-test' } } } },
    });
    const { plan, source } = fakeResolved({
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'api',
          prompt: 'hi',
          api: { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
      ],
    });
    const issues = validatePlan(plan, source, { config, agents: AGENTS });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeUndefined();
  });

  it('coexists with YAAO_PLAN_API_NO_KEY when both apply', () => {
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
      ...AGENTS,
      apiKeys: { anthropic: false, openai: false, openrouter: false },
    };
    const issues = validatePlan(plan, source, { config, agents: noKeyAgents });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_NO_KEY')).toBeDefined();
    expect(issues.find((i) => i.code === 'YAAO_PLAN_API_PROVIDER_UNIMPLEMENTED')).toBeDefined();
  });
});
