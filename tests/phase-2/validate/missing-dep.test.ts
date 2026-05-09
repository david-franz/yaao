import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('missing dependency check', () => {
  it('flags a task that depends on an unknown id', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', depends: ['ghost'] },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    const missing = issues.find((i) => i.code === 'YAAO_PLAN_MISSING_DEP');
    expect(missing).toBeDefined();
    expect(missing?.message).toContain('ghost');
  });

  it('clean dependency yields no missing-dep issue', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
      ],
    });
    const issues = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    expect(issues.filter((i) => i.code === 'YAAO_PLAN_MISSING_DEP')).toEqual([]);
  });
});
