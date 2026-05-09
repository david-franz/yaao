import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('branch / worktree collisions', () => {
  it('flags two tasks pinning the same branch', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', branch: 'shared' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', branch: 'shared' },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_DUPLICATE_BRANCH')).toBe(true);
  });

  it('flags two tasks pinning the same worktree', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', worktree: '/tmp/shared' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', worktree: '/tmp/shared' },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_DUPLICATE_WORKTREE')).toBe(true);
  });
});
