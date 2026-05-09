import { describe, it, expect } from 'vitest';
import { buildCopilotArgs } from '../../../src/agents/copilot.js';

describe('buildCopilotArgs', () => {
  it('produces `copilot agent run` with optional --model', () => {
    const args = buildCopilotArgs({ cwd: '/x', prompt: 'p' });
    expect(args).toEqual(['copilot', 'agent', 'run']);
    const withModel = buildCopilotArgs({ cwd: '/x', prompt: 'p', model: 'gpt-4o' });
    expect(withModel).toContain('--model');
    expect(withModel).toContain('gpt-4o');
  });
});
