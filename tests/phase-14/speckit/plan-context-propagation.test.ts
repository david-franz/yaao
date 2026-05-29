import { describe, it, expect } from 'vitest';
import { parseSpecKit } from '../../../src/planner/speckit.js';

describe('F14.5 — Spec Kit content propagation through parser', () => {
  it('preserves spec.md and plan.md bodies on ParsedPlan', () => {
    const parsed = parseSpecKit({
      title: 'My Plan',
      spec: '# My Plan — Spec\n\nWe build a thing.\n\n## Constraints\n\nNo Postgres.',
      plan: '# My Plan — Plan\n\nWe will use SQLite + Drizzle.',
      tasks: '- [ ] **scaffold** — Scaffold project',
    });
    expect(parsed.specContent).toContain('## Constraints');
    expect(parsed.specContent).toContain('No Postgres');
    expect(parsed.planContent).toContain('SQLite + Drizzle');
  });

  it('leaves specContent/planContent undefined when only tasks.md is supplied', () => {
    const parsed = parseSpecKit({
      tasks: '- [ ] **a** — A',
    });
    expect(parsed.specContent).toBeUndefined();
    expect(parsed.planContent).toBeUndefined();
  });

  it('also preserves the legacy title + description extraction', () => {
    const parsed = parseSpecKit({
      spec: '# My Plan — Spec\n\nProblem statement first line.\n\n## Constraints',
      tasks: '- [ ] **a** — A',
    });
    expect(parsed.title).toBe('My Plan');
    expect(parsed.description).toBe('Problem statement first line.');
  });
});
