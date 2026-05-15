import { describe, it, expect } from 'vitest';
import { renderDag } from '../../../src/tui/render-dag.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('renderDag', () => {
  it('lays out a diamond DAG into 3 layers', () => {
    const { plan } = fakeResolved({
      plan: { name: 'di' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'p', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'p', depends: ['a'] },
        { id: 'd', title: 'D', agent: 'claude-code', prompt: 'p', depends: ['b', 'c'] },
      ],
    });
    const r = renderDag(plan, { ascii: true });
    expect(r.layers).toHaveLength(3);
    expect(r.layers[0]).toEqual(['a']);
    expect(r.layers[1]?.sort()).toEqual(['b', 'c']);
    expect(r.layers[2]).toEqual(['d']);
    expect(r.text).toContain('layer 1');
    expect(r.text).toContain('layer 3');
  });

  it('renders status icons per task', () => {
    const { plan } = fakeResolved({
      plan: { name: 'st' },
      tasks: [{ id: 'only', title: 'Only task', agent: 'claude-code', prompt: 'p' }],
    });
    const text = renderDag(plan, {
      statuses: new Map([['only', 'running']]),
      ascii: true,
    }).text;
    expect(text).toContain('~ Only task');
  });
});
