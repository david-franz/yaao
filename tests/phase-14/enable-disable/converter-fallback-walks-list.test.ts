import { describe, it, expect } from 'vitest';
import { assignAgent } from '../../../src/converter/assign-agent.js';
import { ConfigSchema } from '../../../src/config/schema.js';

describe('F14.1 — converter fallback walks enabled list', () => {
  it('uses defaults.agent when it is enabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'cursor' },
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: true },
      },
    });
    const r = assignAgent(
      { id: 'a', title: 'A', depends: [], prompt: 'hi', files: [] },
      { config },
    );
    expect(r.agent).toBe('cursor');
    expect(r.demoted).toBeFalsy();
  });

  it('demotes to first enabled agent when defaults.agent is disabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'claude-code' },
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: true },
        codex: { enabled: false },
      },
    });
    const r = assignAgent(
      { id: 'a', title: 'A', depends: [], prompt: 'hi', files: [] },
      { config },
    );
    expect(r.agent).toBe('copilot');
    expect(r.reason).toMatch(/demoted from claude-code/);
  });

  it('demotes an explicit task agent that is disabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'cursor' },
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: true },
      },
    });
    const r = assignAgent(
      { id: 'a', title: 'A', depends: [], prompt: 'hi', files: [], agent: 'claude-code' },
      { config },
    );
    expect(r.agent).toBe('cursor');
    expect(r.demoted).toBe(true);
  });

  it('throws YAAO_NO_ENABLED_AGENTS when nothing resolves', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'claude-code' },
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        codex: { enabled: false },
        api: { providers: {} },
      },
    });
    expect(() =>
      assignAgent({ id: 'a', title: 'A', depends: [], prompt: 'hi', files: [] }, { config }),
    ).toThrow(/YAAO_NO_ENABLED_AGENTS|no enabled agent/);
  });
});
