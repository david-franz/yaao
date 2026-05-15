import { describe, it, expect } from 'vitest';
import { renderStatusTable } from '../../../src/tui/status-table.js';
import type { RunSummary } from '../../../src/git/journal.js';

describe('renderStatusTable', () => {
  it('renders a basic table with running tasks first', () => {
    const summary: RunSummary = {
      runId: 'r1',
      planFile: 'x.yaml',
      planHash: 'h',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      tasks: {
        a: { status: 'completed', agent: 'claude-code', branch: 'p/a', durationMs: 1500 },
        b: { status: 'running', agent: 'cursor', branch: 'p/b' },
        c: { status: 'pending' },
      },
    };
    const text = renderStatusTable(summary, { ascii: true });
    const dataRows = text
      .split('\n')
      .filter((l) => /^[abc]\b/.test(l)); // only task rows start with a/b/c
    // 'b' (running) appears before 'a' (completed) before 'c' (pending)
    expect(dataRows.map((r) => r[0])).toEqual(['b', 'c', 'a']);
    expect(text).toContain('1s');
  });
});
