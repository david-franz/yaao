import { describe, it, expect } from 'vitest';
import { parseSpecKit } from '../../../src/planner/speckit.js';

describe('F14.5 — YAAO_SPECKIT_PARSE_EMPTY', () => {
  it('surfaces a clear warning when tasks.md has no parseable task lines', () => {
    const parsed = parseSpecKit({
      tasks: '# My Plan — Tasks\n\nSome prose that does not match.',
    });
    expect(parsed.tasks).toEqual([]);
    const issue = parsed.issues.find((i) => i.code === 'YAAO_SPECKIT_PARSE_EMPTY');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/task-id/);
    expect(issue?.message).toMatch(/checkbox|bold|dash/i);
  });

  it('does NOT raise the warning when tasks parse successfully', () => {
    const parsed = parseSpecKit({
      tasks: '# Tasks\n\n- [ ] **a** — A\n- [ ] **b** — B\n',
    });
    expect(parsed.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(parsed.issues.find((i) => i.code === 'YAAO_SPECKIT_PARSE_EMPTY')).toBeUndefined();
  });

  it('flags the warning on a single-line tasks.md that misses the shape', () => {
    const parsed = parseSpecKit({ tasks: '- scaffold - Scaffold project' });
    expect(parsed.tasks).toEqual([]);
    expect(parsed.issues.find((i) => i.code === 'YAAO_SPECKIT_PARSE_EMPTY')).toBeDefined();
  });
});
