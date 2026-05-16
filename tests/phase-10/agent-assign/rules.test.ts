import { describe, it, expect } from 'vitest';
import { assignAgent } from '../../../src/converter/assign-agent.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { ParsedTask } from '../../../src/planner/markdown.js';

function t(
  partial: Partial<ParsedTask> & Pick<ParsedTask, 'id' | 'title'>,
): ParsedTask {
  return {
    depends: [],
    prompt: '',
    files: [],
    ...partial,
  };
}

describe('assignAgent', () => {
  it('explicit suggestion wins', () => {
    const r = assignAgent(t({ id: 'a', title: 'A', agent: 'cursor', model: 'sonnet' }), {
      config: DEFAULT_CONFIG,
    });
    expect(r.agent).toBe('cursor');
    expect(r.model).toBe('sonnet');
    expect(r.reason).toMatch(/suggested/);
  });

  it('built-in test rule routes tests to codex', () => {
    const r = assignAgent(t({ id: 'tests', title: 'End-to-end tests' }), {
      config: DEFAULT_CONFIG,
    });
    expect(r.agent).toBe('codex');
  });

  it('built-in UI rule routes Login UI to cursor', () => {
    const r = assignAgent(t({ id: 'login-ui', title: 'Login UI' }), { config: DEFAULT_CONFIG });
    expect(r.agent).toBe('cursor');
  });

  it('user rules win over built-ins (precedence)', () => {
    const r = assignAgent(t({ id: 'tests', title: 'E2E tests' }), {
      config: DEFAULT_CONFIG,
      rules: [
        { match: { 'title-regex': '(?i)test' }, agent: 'claude-code', model: 'haiku' },
      ],
    });
    expect(r.agent).toBe('claude-code');
    expect(r.model).toBe('haiku');
  });

  it('falls back to project default when no rule matches', () => {
    const r = assignAgent(t({ id: 'foo', title: 'Foo' }), {
      config: DEFAULT_CONFIG,
      disableBuiltins: true,
    });
    expect(r.agent).toBe(DEFAULT_CONFIG.defaults.agent);
  });

  it('demotes agent: api when no provider key is available', () => {
    const r = assignAgent(t({ id: 'a', title: 'A', agent: 'api' }), {
      config: DEFAULT_CONFIG,
      apiAvailable: false,
    });
    expect(r.demoted).toBe(true);
    expect(r.agent).toBe(DEFAULT_CONFIG.defaults.agent);
  });

  it('skips a built-in rule when its agent is disabled in config', () => {
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        cursor: { ...DEFAULT_CONFIG.agents.cursor, enabled: false },
        codex: { ...DEFAULT_CONFIG.agents.codex, enabled: false },
      },
    };
    // Title matches the built-in "ui|frontend|page|component" rule which would
    // normally route to cursor — but cursor is disabled, so it should fall
    // through to the project default instead.
    const r = assignAgent(t({ id: 'ui-1', title: 'Build the login page UI' }), { config });
    expect(r.agent).toBe(config.defaults.agent);
    expect(r.reason).toMatch(/project default/);
  });

  it('demotes a task-suggested disabled agent to project default', () => {
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        cursor: { ...DEFAULT_CONFIG.agents.cursor, enabled: false },
      },
    };
    const r = assignAgent(t({ id: 'a', title: 'A', agent: 'cursor' }), { config });
    expect(r.demoted).toBe(true);
    expect(r.agent).toBe(config.defaults.agent);
    expect(r.reason).toMatch(/disabled in config/);
  });

  describe('per-agent default-model', () => {
    it('falls back to agents.<name>.default-model when the task has no model', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agents: {
          ...DEFAULT_CONFIG.agents,
          'claude-code': { ...DEFAULT_CONFIG.agents['claude-code'], 'default-model': 'sonnet' },
        },
      };
      const r = assignAgent(t({ id: 'a', title: 'A', agent: 'claude-code' }), { config });
      expect(r.agent).toBe('claude-code');
      expect(r.model).toBe('sonnet');
    });

    it('still respects an explicit task model over the per-agent default', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agents: {
          ...DEFAULT_CONFIG.agents,
          'claude-code': { ...DEFAULT_CONFIG.agents['claude-code'], 'default-model': 'sonnet' },
        },
      };
      const r = assignAgent(t({ id: 'a', title: 'A', agent: 'claude-code', model: 'haiku' }), {
        config,
      });
      expect(r.model).toBe('haiku');
    });

    it('falls back to defaults.model when no per-agent default is set', () => {
      const r = assignAgent(t({ id: 'a', title: 'A', agent: 'claude-code' }), {
        config: DEFAULT_CONFIG,
      });
      expect(r.model).toBe(DEFAULT_CONFIG.defaults.model);
    });

    it('uses the per-agent default when a rule picks the agent but no rule-model', () => {
      const config = {
        ...DEFAULT_CONFIG,
        agents: {
          ...DEFAULT_CONFIG.agents,
          cursor: { ...DEFAULT_CONFIG.agents.cursor, 'default-model': 'cursor-fast' },
        },
      };
      const r = assignAgent(t({ id: 'login-ui', title: 'Login UI' }), { config });
      expect(r.agent).toBe('cursor');
      expect(r.model).toBe('cursor-fast');
    });
  });
});
