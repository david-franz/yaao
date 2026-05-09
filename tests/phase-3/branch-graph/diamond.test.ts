import { describe, it, expect } from 'vitest';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('diamond DAG', () => {
  it('picks primary by descendant count, lex tiebreak', () => {
    // a -> b, a -> c, b+c -> d. b and c both have 1 descendant; lex picks b.
    const { plan } = fakeResolved({
      plan: { name: 'di' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'd', title: 'D', agent: 'claude-code', prompt: 'hi', depends: ['b', 'c'] },
      ],
    });
    const bp = planBranches(plan);
    const d = bp.byTask.get('d');
    expect(d?.baseBranch).toBe('di/b');
    expect(d?.parentBranches).toEqual(['di/c']);
  });
});
