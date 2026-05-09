import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../../src/plan/schema/plan.js';
import { resolvePlan } from '../../../src/plan/schema/resolve.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('resolvePlan', () => {
  it('fills config defaults from yaao.config.json', () => {
    const plan = PlanSchema.parse({
      plan: { name: 'p', version: 1 },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' }],
    });
    const r = resolvePlan(plan, { config: DEFAULT_CONFIG });
    expect(r.config['base-branch']).toBe('main');
    expect(r.config['max-parallel']).toBe(4);
    expect(r.config.merge.strategy).toBe('auto');
    expect(r.config.merge['on-conflict']).toBe('manual');
  });

  it('synthesizes branch and worktree from plan name + task id', () => {
    const plan = PlanSchema.parse({
      plan: { name: 'oauth', version: 1 },
      tasks: [{ id: 'api', title: 'API', agent: 'claude-code', prompt: 'hi' }],
    });
    const r = resolvePlan(plan, { config: DEFAULT_CONFIG });
    expect(r.tasks[0]?.branch).toBe('oauth/api');
    expect(r.tasks[0]?.worktree).toContain('worktrees/oauth/api');
  });

  it('respects explicit task branch / worktree overrides', () => {
    const plan = PlanSchema.parse({
      plan: { name: 'p', version: 1 },
      tasks: [
        {
          id: 'a',
          title: 'A',
          agent: 'claude-code',
          prompt: 'hi',
          branch: 'custom/branch',
          worktree: '/tmp/custom',
        },
      ],
    });
    const r = resolvePlan(plan, { config: DEFAULT_CONFIG });
    expect(r.tasks[0]?.branch).toBe('custom/branch');
    expect(r.tasks[0]?.worktree).toBe('/tmp/custom');
  });

  it('plan-level config overrides yaao.config defaults', () => {
    const plan = PlanSchema.parse({
      plan: { name: 'p', version: 1 },
      config: { 'max-parallel': 8, 'base-branch': 'develop' },
      tasks: [],
    });
    const r = resolvePlan(plan, { config: DEFAULT_CONFIG });
    expect(r.config['max-parallel']).toBe(8);
    expect(r.config['base-branch']).toBe('develop');
  });
});
