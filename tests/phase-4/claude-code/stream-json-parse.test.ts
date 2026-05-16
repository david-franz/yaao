import { describe, it, expect } from 'vitest';
import { parseClaudeStreamJsonLine, buildClaudeArgs, resolveClaudeModel } from '../../../src/agents/claude-code.js';

describe('parseClaudeStreamJsonLine', () => {
  it('maps text content blocks to stdout events', () => {
    const ev = parseClaudeStreamJsonLine(
      JSON.stringify({ message: { content: [{ type: 'text', text: 'hello world' }] } }),
    );
    expect(ev?.type).toBe('stdout');
    expect(ev?.data).toBe('hello world');
  });

  it('maps tool_use blocks to tool-use events', () => {
    const ev = parseClaudeStreamJsonLine(
      JSON.stringify({
        message: { content: [{ type: 'tool_use', name: 'write_file', input: { path: 'a.ts' } }] },
      }),
    );
    expect(ev?.type).toBe('tool-use');
    const data = JSON.parse(ev?.data ?? '{}') as { name: string };
    expect(data.name).toBe('write_file');
  });

  it('maps error lines to stderr events', () => {
    const ev = parseClaudeStreamJsonLine(JSON.stringify({ type: 'error', message: 'boom' }));
    expect(ev?.type).toBe('stderr');
  });

  it('non-JSON lines fall through as stdout (preserves visibility)', () => {
    const ev = parseClaudeStreamJsonLine('not json at all');
    expect(ev?.type).toBe('stdout');
  });
});

describe('buildClaudeArgs', () => {
  it('produces --print --output-format stream-json with model + mcp-config + system prompt', () => {
    const args = buildClaudeArgs(
      {
        cwd: '/x',
        prompt: 'p',
        model: 'sonnet',
        skills: ['yaao-implementer'],
        systemPrompt: 'be brief',
      },
      '/tmp/mcp.json',
    );
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    // `claude` requires --verbose when --print + --output-format stream-json are used.
    expect(args).toContain('--verbose');
    // Default (no `permissions` set) maps to bypassPermissions so the agent
    // can run install commands etc. inside the isolated worktree without
    // hanging on confirmation prompts under `--print`.
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-6');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/mcp.json');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('be brief');
  });

  it('does not pass --skill (the real claude CLI does not have that flag)', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', skills: ['a', 'b', 'c'] });
    expect(args).not.toContain('--skill');
    expect(args).not.toContain('a');
  });

  it('maps permissions to claude --permission-mode', () => {
    const ask = buildClaudeArgs({ cwd: '/x', prompt: 'p', permissions: 'ask' });
    expect(ask).toContain('default');
    const edits = buildClaudeArgs({ cwd: '/x', prompt: 'p', permissions: 'allow-edits' });
    expect(edits).toContain('acceptEdits');
    const all = buildClaudeArgs({ cwd: '/x', prompt: 'p', permissions: 'allow-all' });
    expect(all).toContain('bypassPermissions');
  });
});

describe('resolveClaudeModel', () => {
  it('translates aliases to current IDs and passes through explicit IDs', () => {
    expect(resolveClaudeModel('opus')).toBe('claude-opus-4-7');
    expect(resolveClaudeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(resolveClaudeModel(undefined)).toBeUndefined();
  });
});
