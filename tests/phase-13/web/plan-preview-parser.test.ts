import { describe, it, expect } from 'vitest';
import { __testing } from '../../../web/src/pages/PlanEdit.tsx';

const { parsePreview } = __testing;

describe('PlanEdit YAML preview parser', () => {
  it('extracts ids, titles, agents, and depends', () => {
    const yaml = `plan:
  name: x
tasks:
  - id: a
    title: First
    agent: claude-code
    depends: []
  - id: b
    title: Second
    agent: cursor
    depends: [a]
`;
    const r = parsePreview(yaml);
    expect(r.tasks).toEqual([
      { id: 'a', title: 'First', agent: 'claude-code', depends: [] },
      { id: 'b', title: 'Second', agent: 'cursor', depends: ['a'] },
    ]);
  });

  it('returns no tasks when the block-list depends form is used (block-list form lives on the next lines)', () => {
    // The lightweight parser handles the inline `[a]` form; block-list
    // (`depends:\n  - a\n  - b`) is also supported via the `inDepends`
    // continuation handling.
    const yaml = `tasks:
  - id: t
    title: T
    depends:
      - a
      - b
    agent: cc
`;
    const r = parsePreview(yaml);
    expect(r.tasks[0]?.depends).toEqual(['a', 'b']);
  });

  it('collapses to an empty list when the tasks: block is missing', () => {
    expect(parsePreview('plan:\n  name: x\n').tasks).toEqual([]);
  });

  it('tolerates comments and blank lines', () => {
    const yaml = `tasks:
  # leading comment
  - id: a
    agent: cc
  # mid-block comment

  - id: b
    agent: cc
`;
    const r = parsePreview(yaml);
    expect(r.tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
