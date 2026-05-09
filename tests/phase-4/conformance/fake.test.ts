import { describe, it, expect } from 'vitest';
import { FakeBackend } from '../../../src/agents/fake.js';
import { AgentCancelledError, AgentTimeoutError } from '../../../src/log/errors.js';

describe('AgentBackend conformance: FakeBackend', () => {
  it('emits scripted events and resolves with the result', async () => {
    const backend = new FakeBackend({
      events: [
        { type: 'stdout', data: 'hello\n' },
        { type: 'tool-use', data: '{"tool":"write_file"}' },
        { type: 'stdout', data: 'done\n' },
      ],
      toolUseCount: 1,
    });
    const proc = await backend.spawn({ cwd: '/tmp', prompt: 'hi' });
    const captured: string[] = [];
    for await (const ev of proc.events) captured.push(`${ev.type}:${ev.data}`);
    const result = await proc.completed;
    expect(captured).toEqual([
      'stdout:hello\n',
      'tool-use:{"tool":"write_file"}',
      'stdout:done\n',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.toolUseCount).toBe(1);
    expect(result.stdout).toContain('hello');
  });

  it('cancel() rejects completed with AgentCancelledError', async () => {
    const backend = new FakeBackend({
      events: [{ type: 'stdout', data: 'a' }],
      delayMs: 100,
    });
    const proc = await backend.spawn({ cwd: '/tmp', prompt: 'hi' });
    void proc.cancel('user');
    await expect(proc.completed).rejects.toBeInstanceOf(AgentCancelledError);
  });

  it('timeout cancels and rejects with AgentTimeoutError', async () => {
    const backend = new FakeBackend({
      events: [{ type: 'stdout', data: 'a' }],
      delayMs: 1000,
    });
    const proc = await backend.spawn({ cwd: '/tmp', prompt: 'hi', timeout: 50 });
    await expect(proc.completed).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it('isAvailable returns the scripted report', async () => {
    const backend = new FakeBackend({
      events: [],
      availability: { available: false, reason: 'not configured' },
    });
    const r = await backend.isAvailable();
    expect(r.available).toBe(false);
    expect(r.reason).toBe('not configured');
  });
});
