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
    const ids = text.split('\n').filter((l) => /^\w/.test(l) && (l.includes('running') || l.includes('completed') || l.includes('pending')));
    // 'b' (running) appears before 'a' (completed)
    expect(ids[0]?.startsWith('b')).toBe(true);
    expect(text).toContain('1s');
  });
});
