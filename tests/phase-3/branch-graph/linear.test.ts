import { describe, it, expect } from 'vitest';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('linear chain', () => {
  it('a -> b -> c forks each task off its predecessor', () => {
    const { plan } = fakeResolved({
      plan: { name: 'lin' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['b'] },
      ],
    });
    const bp = planBranches(plan);
    expect(bp.baseBranch).toBe('main');
    expect(bp.byTask.get('a')?.baseBranch).toBe('main');
    expect(bp.byTask.get('b')?.baseBranch).toBe('lin/a');
    expect(bp.byTask.get('c')?.baseBranch).toBe('lin/b');
    expect(bp.byTask.get('c')?.parentBranches).toEqual([]);
  });
});
