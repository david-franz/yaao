import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../../src/plan/schema/plan.js';
import { resolvePlan } from '../../../src/plan/schema/resolve.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

/**
 * The full lifecycle would require a worktree + agent backend, which is
 * overkill for this guarantee. We assert directly against the schema +
 * resolve path so the plan.context field flows through to the
 * ResolvedPlan.plan.context shape lifecycle reads.
 */
describe('F14.5 — plan.context survives schema/resolve and reaches the runtime', () => {
  it('plan.context on the source YAML survives PlanSchema.parse and resolvePlan', () => {
    const raw = PlanSchema.parse({
      plan: {
        name: 'p',
        version: 1,
        context: '## From spec.md\n\nBuild a thing.',
      },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'do it' },
      ],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.plan.context).toBe('## From spec.md\n\nBuild a thing.');
  });

  it('config.context.plan-context-budget flows through resolvePlan', () => {
    const raw = PlanSchema.parse({
      plan: { name: 'p', version: 1 },
      config: { context: { 'plan-context-budget': 1500 } },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'do it' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.config.context['plan-context-budget']).toBe(1500);
  });
});
