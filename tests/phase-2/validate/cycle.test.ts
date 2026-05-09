import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('cycle detection', () => {
  it('flags a cycle and lists its members', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', depends: ['c'] },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['b'] },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    const cycle = issues.find((i) => i.code === 'YAAO_PLAN_CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.message).toMatch(/a/);
    expect(cycle?.message).toMatch(/b/);
    expect(cycle?.message).toMatch(/c/);
  });

  it('detects a self-cycle as YAAO_PLAN_SELF_DEP', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_SELF_DEP')).toBe(true);
  });

  it('clean DAG produces no cycle issues', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.filter((i) => i.code === 'YAAO_PLAN_CYCLE')).toEqual([]);
  });
});
