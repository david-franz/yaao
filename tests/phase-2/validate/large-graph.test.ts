import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../../src/plan/schema/plan.js';
import { resolvePlan } from '../../../src/plan/schema/resolve.js';
import { validatePlan } from '../../../src/plan/validate/index.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { SourceMap } from '../../../src/plan/yaml/loader.js';

describe('large-graph performance', () => {
  it('validates a 5000-task chain quickly with no cycles reported', () => {
    const N = 5000;
    const tasks = Array.from({ length: N }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      agent: 'claude-code' as const,
      prompt: 'x',
      depends: i === 0 ? [] : [`t${i - 1}`],
    }));
    const parsed = PlanSchema.parse({ plan: { name: 'big', version: 1 }, tasks });
    const resolved = resolvePlan(parsed, { config: DEFAULT_CONFIG });
    const source: SourceMap = new Map();
    const start = Date.now();
    const issues = validatePlan(resolved, source, { config: DEFAULT_CONFIG });
    const took = Date.now() - start;
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(took).toBeLessThan(2000);
  });
});
