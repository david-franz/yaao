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
});
