import { describe, it, expect } from 'vitest';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('topological order', () => {
  it('produces a valid topo order respecting deps', () => {
    const { plan } = fakeResolved({
      plan: { name: 'topo' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'd', title: 'D', agent: 'claude-code', prompt: 'hi', depends: ['b', 'c'] },
      ],
    });
    const bp = planBranches(plan);
    const order = bp.topoOrder;
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });
});
