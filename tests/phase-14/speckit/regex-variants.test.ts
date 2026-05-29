import { describe, it, expect } from 'vitest';
import { parseSpecKit } from '../../../src/planner/speckit.js';

function tasksOf(tasksMd: string): string[] {
  return parseSpecKit({ tasks: tasksMd }).tasks.map((t) => t.id);
}

describe('F14.5 — Spec Kit task-line regex relaxation', () => {
  it('parses the canonical shape', () => {
    expect(tasksOf('- [ ] **scaffold** — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses checked tasks', () => {
    expect(tasksOf('- [x] **scaffold** — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses bullet * instead of -', () => {
    expect(tasksOf('* [ ] **scaffold** — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses tasks without a checkbox', () => {
    expect(tasksOf('- **scaffold** — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses single-asterisk emphasis', () => {
    expect(tasksOf('- [ ] *scaffold* — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses underscore emphasis', () => {
    expect(tasksOf('- [ ] _scaffold_ — Scaffold project')).toEqual(['scaffold']);
  });

  it('parses en-dash separator', () => {
    expect(tasksOf('- [ ] **scaffold** – Scaffold project')).toEqual(['scaffold']);
  });

  it('parses ASCII hyphen separator', () => {
    expect(tasksOf('- [ ] **scaffold** - Scaffold project')).toEqual(['scaffold']);
  });

  it('does NOT match prose-like lines without emphasis', () => {
    // No emphasis around the id → must not parse as a task or every
    // hyphen-separated phrase in prose would become a task.
    expect(tasksOf('- scaffold - Scaffold project')).toEqual([]);
  });

  it('does NOT match an id with uppercase letters (canonical slug shape)', () => {
    expect(tasksOf('- [ ] **Scaffold** — Title')).toEqual([]);
  });
});
