import { describe, it, expect } from 'vitest';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('--strict promotes warnings to errors', () => {
  it('warning becomes error in strict mode', () => {
    const { plan, source } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', skills: ['ghost'] },
      ],
    });
    const lenient = validatePlan(plan, source, { config: DEFAULT_CONFIG });
    const skillIssue = lenient.find((i) => i.code === 'YAAO_PLAN_SKILL_UNKNOWN');
    expect(skillIssue?.severity).toBe('warning');

    const strict = validatePlan(plan, source, { config: DEFAULT_CONFIG, strict: true });
    const strictSkill = strict.find((i) => i.code === 'YAAO_PLAN_SKILL_UNKNOWN');
    expect(strictSkill?.severity).toBe('error');
  });
});
