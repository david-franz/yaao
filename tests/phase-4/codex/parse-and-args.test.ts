import { describe, it, expect } from 'vitest';
import { buildCodexArgs, parseCodexJsonLine } from '../../../src/agents/codex.js';

describe('buildCodexArgs', () => {
  it('uses `exec --json` and accepts a model', () => {
    expect(buildCodexArgs({ cwd: '/x', prompt: 'p' })).toEqual(['exec', '--json']);
    const withModel = buildCodexArgs({ cwd: '/x', prompt: 'p', model: 'gpt-5-codex' });
    expect(withModel).toContain('--model');
    expect(withModel).toContain('gpt-5-codex');
  });
});

describe('parseCodexJsonLine', () => {
  it('maps text events to stdout', () => {
    const ev = parseCodexJsonLine(JSON.stringify({ text: 'hello' }));
    expect(ev?.type).toBe('stdout');
    expect(ev?.data).toBe('hello');
  });

  it('maps tool_call events to tool-use', () => {
    const ev = parseCodexJsonLine(
      JSON.stringify({ type: 'tool_call', tool_name: 'apply_patch', input: { diff: '...' } }),
    );
    expect(ev?.type).toBe('tool-use');
  });

  it('maps thinking events to thinking', () => {
    const ev = parseCodexJsonLine(JSON.stringify({ type: 'thinking', thinking: 'considering...' }));
    expect(ev?.type).toBe('thinking');
  });

  it('maps error events to stderr', () => {
    const ev = parseCodexJsonLine(JSON.stringify({ type: 'error', message: 'oops' }));
    expect(ev?.type).toBe('stderr');
  });

  it('non-JSON falls through as stdout', () => {
    const ev = parseCodexJsonLine('plain output');
    expect(ev?.type).toBe('stdout');
  });
});
