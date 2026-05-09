import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { YaaoConfig } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('agent availability checks', () => {
  it('errors when an agent is disabled in config', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'cursor', prompt: 'hi' },
      ],
    });
    const cfg: YaaoConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as YaaoConfig;
    (cfg.agents as unknown as Record<string, { enabled: boolean; bin?: string }>)['cursor'] = {
      enabled: false,
      bin: 'cursor-agent',
    };
    const issues = validatePlan(plan, source, { config: cfg });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_AGENT_DISABLED')).toBe(true);
  });

  it('warns when an agent is enabled but binary unavailable', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'codex', prompt: 'hi' },
      ],
    });
    const issues = validatePlan(plan, source, {
      config: DEFAULT_CONFIG,
      agents: {
        available: { 'claude-code': true, cursor: true, copilot: true, codex: false, api: true },
        apiKeys: { anthropic: true, openai: true, openrouter: true },
      },
    });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_AGENT_NOT_INSTALLED')).toBe(true);
  });

  it('errors when agent: api is used but no provider key resolves', () => {
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
    const cfg: YaaoConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as YaaoConfig;
    cfg.agents.api.providers = { anthropic: { 'api-key': 'sk-x' } } as YaaoConfig['agents']['api']['providers'];
    const issues = validatePlan(plan, source, {
      config: cfg,
      agents: {
        available: { 'claude-code': true, cursor: true, copilot: true, codex: true, api: true },
        apiKeys: { anthropic: false, openai: false, openrouter: false },
      },
    });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_API_NO_KEY')).toBe(true);
  });
});
