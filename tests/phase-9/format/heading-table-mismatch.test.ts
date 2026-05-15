import { describe, it, expect } from 'vitest';
import { parseMarkdownPlan } from '../../../src/planner/markdown.js';

describe('heading vs table mismatch detection', () => {
  it('reports a task in the table with no matching heading', () => {
    const src = `# Plan

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | A     |         |
| b  | B     |         |

## a — A

prose
`;
    const r = parseMarkdownPlan(src);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('YAAO_PLAN_TASK_MISSING_HEADING');
  });

  it('reports a heading with no matching table row', () => {
    const src = `# Plan

## Tasks

| id | title | depends |
|----|-------|---------|
| a  | A     |         |

## a — A

prose

## b — B

prose
`;
    const r = parseMarkdownPlan(src);
    expect(r.issues.map((i) => i.code)).toContain('YAAO_PLAN_TASK_MISSING_TABLE_ROW');
  });
});
