import { describe, it, expect } from 'vitest';
import {
  isAgentEnabled,
  enabledAgents,
  pickEnabledAgent,
} from '../../../src/config/enabled-agents.js';
import { ConfigSchema } from '../../../src/config/schema.js';

describe('F14.1 — enabled-agents helpers', () => {
  it('isAgentEnabled returns true for CLI agents when flag is true or unset', () => {
    const config = ConfigSchema.parse({ version: 1 });
    expect(isAgentEnabled(config, 'claude-code')).toBe(true);
    expect(isAgentEnabled(config, 'cursor')).toBe(true);
  });

  it('isAgentEnabled returns false for an explicit enabled: false', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: { 'claude-code': { enabled: false } },
    });
    expect(isAgentEnabled(config, 'claude-code')).toBe(false);
  });

  it('isAgentEnabled treats api as enabled only when a provider key is configured', () => {
    const noKey = ConfigSchema.parse({ version: 1 });
    expect(isAgentEnabled(noKey, 'api')).toBe(false);
    const withKey = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { anthropic: { 'api-key': 'sk-test' } } } },
    });
    expect(isAgentEnabled(withKey, 'api')).toBe(true);
  });

  it('enabledAgents returns canonical-order subset', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: true },
        copilot: { enabled: true },
        codex: { enabled: false },
      },
    });
    expect(enabledAgents(config)).toEqual(['cursor', 'copilot']);
  });

  it('pickEnabledAgent prefers defaults.agent when enabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'cursor' },
      agents: {
        'claude-code': { enabled: true },
        cursor: { enabled: true },
      },
    });
    expect(pickEnabledAgent(config)).toBe('cursor');
  });

  it('pickEnabledAgent falls back to first enabled when default is disabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      defaults: { agent: 'claude-code' },
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: true },
      },
    });
    expect(pickEnabledAgent(config)).toBe('copilot');
  });

  it('pickEnabledAgent returns undefined when nothing is enabled', () => {
    const config = ConfigSchema.parse({
      version: 1,
      agents: {
        'claude-code': { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        codex: { enabled: false },
      },
    });
    expect(pickEnabledAgent(config)).toBeUndefined();
  });
});
