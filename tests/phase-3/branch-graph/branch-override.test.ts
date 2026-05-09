import { describe, it, expect } from 'vitest';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('branch override', () => {
  it('honors task.branch when explicitly set', () => {
    const { plan } = fakeResolved({
      plan: { name: 'ov' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', branch: 'custom/a' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
      ],
    });
    const bp = planBranches(plan);
    expect(bp.byTask.get('a')?.branch).toBe('custom/a');
    expect(bp.byTask.get('b')?.baseBranch).toBe('custom/a');
  });
});
