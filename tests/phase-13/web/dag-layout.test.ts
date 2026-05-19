import { describe, it, expect } from 'vitest';
import { layoutDag } from '../../../web/src/dag-layout.ts';

describe('layoutDag', () => {
  it('positions a linear chain in successive columns', () => {
    const layout = layoutDag([
      { id: 'a', title: 'A', agent: 'cc', depends: [] },
      { id: 'b', title: 'B', agent: 'cc', depends: ['a'] },
      { id: 'c', title: 'C', agent: 'cc', depends: ['b'] },
    ]);
    const xs = layout.nodes.map((n) => n.x);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
    // Same row (single node per level).
    const ys = layout.nodes.map((n) => n.y);
    expect(ys[0]).toBe(ys[1]);
    expect(ys[1]).toBe(ys[2]);
  });

  it('places diamond-DAG joins back into a single column', () => {
    //   root → a → join
    //        ↘ b ↗
    const layout = layoutDag([
      { id: 'root', title: 'R', agent: 'cc', depends: [] },
      { id: 'a', title: 'A', agent: 'cc', depends: ['root'] },
      { id: 'b', title: 'B', agent: 'cc', depends: ['root'] },
      { id: 'join', title: 'J', agent: 'cc', depends: ['a', 'b'] },
    ]);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId['root']!.level).toBe(0);
    expect(byId['a']!.level).toBe(1);
    expect(byId['b']!.level).toBe(1);
    expect(byId['join']!.level).toBe(2);
    // Siblings in the same column don't overlap vertically.
    expect(byId['a']!.y).not.toBe(byId['b']!.y);
  });

  it('produces one edge per declared dependency', () => {
    const layout = layoutDag([
      { id: 'a', title: 'A', agent: 'cc', depends: [] },
      { id: 'b', title: 'B', agent: 'cc', depends: ['a'] },
      { id: 'c', title: 'C', agent: 'cc', depends: ['a', 'b'] },
    ]);
    const edges = layout.edges.map((e) => `${e.fromId}->${e.toId}`).sort();
    expect(edges).toEqual(['a->b', 'a->c', 'b->c']);
  });

  it('returns sane width/height bounds enclosing every node', () => {
    const layout = layoutDag([
      { id: 'a', title: 'A', agent: 'cc', depends: [] },
      { id: 'b', title: 'B', agent: 'cc', depends: ['a'] },
    ]);
    for (const n of layout.nodes) {
      expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('handles an empty plan without crashing', () => {
    const layout = layoutDag([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
