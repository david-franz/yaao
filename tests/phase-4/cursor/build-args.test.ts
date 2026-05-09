import { describe, it, expect } from 'vitest';
import { buildCursorArgs } from '../../../src/agents/cursor.js';

describe('buildCursorArgs', () => {
  it('uses --print and accepts a model', () => {
    const args = buildCursorArgs({ cwd: '/x', prompt: 'p', model: 'sonnet-4' });
    expect(args).toContain('--print');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet-4');
  });

  it('omits --model when not provided', () => {
    const args = buildCursorArgs({ cwd: '/x', prompt: 'p' });
    expect(args).not.toContain('--model');
  });
});
