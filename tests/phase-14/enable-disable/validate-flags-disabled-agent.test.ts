import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('F14.1 — YAAO_PLAN_AGENT_DISABLED at validate time', () => {
  it('flags a task using a disabled agent as an error', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { 'claude-code': { enabled: false } },
    });
    const { plan, source } = fakeResolved({
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });
    const issues = validatePlan(plan, source, { config });
    const disabled = issues.find((i) => i.code === 'YAAO_PLAN_AGENT_DISABLED');
    expect(disabled).toBeDefined();
    expect(disabled?.severity).toBe('error');
    expect(disabled?.taskId).toBe('a');
    expect(disabled?.hint).toMatch(/agents\.claude-code\.enabled/);
  });

  it('does NOT flag a task using an enabled agent', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { 'claude-code': { enabled: true } },
    });
    const { plan, source } = fakeResolved({
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });
    const issues = validatePlan(plan, source, { config });
    expect(issues.find((i) => i.code === 'YAAO_PLAN_AGENT_DISABLED')).toBeUndefined();
  });
});
