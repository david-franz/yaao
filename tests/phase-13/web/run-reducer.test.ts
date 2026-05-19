import { describe, it, expect } from 'vitest';
import { reducer, initialState, type JournalEvent } from '../../../web/src/pages/RunDetail.tsx';

function apply(events: JournalEvent[]): ReturnType<typeof reducer> {
  return events.reduce((s, ev, i) => reducer(s, { id: i + 1, ev }), initialState);
}

describe('RunDetail reducer', () => {
  it('builds task state from a typical run journal', () => {
    const s = apply([
      { t: 'run:start', runId: 'r1', planFile: '/x', planHash: 'h' },
      { t: 'task:queued', taskId: 't', depends: [] },
      { t: 'task:ready', taskId: 't' },
      { t: 'task:running', taskId: 't', agent: 'claude-code', branch: 'b/t' },
      { t: 'task:agent-event', taskId: 't', ev: { type: 'thinking', data: 'hmm' } },
      { t: 'task:agent-event', taskId: 't', ev: { type: 'tool-use', data: '{"name":"Read"}' } },
      { t: 'task:completed', taskId: 't', durationMs: 100, filesChanged: 1, commit: 'c'.repeat(40), validation: { command: 'echo ok', exitCode: 0, decisionReason: 'exit-code', mustPass: true } },
      { t: 'task:merged', taskId: 't', into: 'main', mergeCommit: 'm'.repeat(40) },
      { t: 'run:end', status: 'success' },
    ]);
    expect(s.status).toBe('success');
    expect(s.tasks['t']?.status).toBe('completed');
    expect(s.tasks['t']?.agent).toBe('claude-code');
    expect(s.tasks['t']?.commit?.length).toBe(40);
    expect(s.tasks['t']?.validation?.exitCode).toBe(0);
    expect(s.tasks['t']?.mergeStatus).toBe('merged');
    // Activity has lifecycle + thinking + tool-use rows.
    const kinds = s.activity.map((r) => r.kind);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool-use');
  });

  it('records failure with the error object', () => {
    const s = apply([
      { t: 'task:failed', taskId: 't', error: { code: 'YAAO_AGENT_NONZERO', message: 'validation failed' } },
    ]);
    expect(s.tasks['t']?.status).toBe('failed');
    expect(s.tasks['t']?.error?.code).toBe('YAAO_AGENT_NONZERO');
  });

  it('captures merge-failed conflicts', () => {
    const s = apply([
      { t: 'task:merge-failed', taskId: 't', into: 'main', reason: 'conflict', conflicts: ['a.ts'] },
    ]);
    expect(s.tasks['t']?.mergeStatus).toBe('merge-failed');
    expect(s.tasks['t']?.mergeConflicts).toEqual(['a.ts']);
  });

  it('parses tool-use name out of the JSON arg blob', () => {
    const s = apply([{ t: 'task:agent-event', taskId: 't', ev: { type: 'tool-use', data: '{"name":"Bash","input":{}}' } }]);
    const row = s.activity[0];
    expect(row?.kind).toBe('tool-use');
    if (row?.kind === 'tool-use') expect(row.name).toBe('Bash');
  });
});
