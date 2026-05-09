import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('duplicate task id', () => {
  it('flags duplicates', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'a', title: 'B', agent: 'claude-code', prompt: 'hi' },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.some((i) => i.code === 'YAAO_PLAN_DUPLICATE_TASK_ID')).toBe(true);
  });
});
