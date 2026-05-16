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

  it('renders cascade-skipped tasks as "blocked", user-skipped as "skipped"', () => {
    const summary: RunSummary = {
      runId: 'r1',
      planFile: 'x.yaml',
      planHash: 'h',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'failed',
      tasks: {
        a: { status: 'failed' },
        // Cascade-skipped because dep `a` failed → "blocked".
        b: { status: 'skipped', skipReason: 'depFailed' },
        // User-skipped via --skip — keep as "skipped".
        c: { status: 'skipped', skipReason: 'filtered' },
      },
    };
    const text = renderStatusTable(summary, { ascii: true });
    expect(text).toMatch(/^b\s+\s+blocked/m);
    expect(text).toMatch(/^c\s+\s+skipped/m);
  });

  it('keeps the agent column showing who completed a task, even after a failed re-run with a different agent', () => {
    // Simulates the live journal-replay case: a completion was journaled with
    // `agent: claude-code`, a later attempt with copilot left task:running.
    // Sticky-completion preserves status; the completed-agent should win.
    const summary: RunSummary = {
      runId: 'r1',
      planFile: 'x.yaml',
      planHash: 'h',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'failed',
      tasks: {
        a: { status: 'completed', agent: 'claude-code', branch: 'p/a' },
      },
    };
    const text = renderStatusTable(summary, { ascii: true });
    expect(text).toMatch(/a\s+\s+completed\s+claude-code/);
  });
});
