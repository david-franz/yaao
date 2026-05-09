import { describe, it, expect } from 'vitest';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('multi-parent fan-in', () => {
  it('selects the dep with the most descendants as primary', () => {
    // chain: x -> y -> z; w depends on x, y, z. Among them, x has 2 descendants, y has 1, z has 0.
    const { plan } = fakeResolved({
      plan: { name: 'fi' },
      tasks: [
        { id: 'x', title: 'X', agent: 'claude-code', prompt: 'hi' },
        { id: 'y', title: 'Y', agent: 'claude-code', prompt: 'hi', depends: ['x'] },
        { id: 'z', title: 'Z', agent: 'claude-code', prompt: 'hi', depends: ['y'] },
        { id: 'w', title: 'W', agent: 'claude-code', prompt: 'hi', depends: ['x', 'y', 'z'] },
      ],
    });
    const bp = planBranches(plan);
    const w = bp.byTask.get('w');
    // x has the most descendants (it's reachable to y, z, AND w; depending on traversal,
    // x is the right pick or y is). The implementation counts strict descendants of x as
    // {y, z, w} = 3 vs y's {z, w} = 2 vs z's {w} = 1, so primary should be x.
    expect(w?.baseBranch).toBe('fi/x');
    expect(w?.parentBranches.sort()).toEqual(['fi/y', 'fi/z']);
  });
});
