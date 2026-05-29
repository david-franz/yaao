import { describe, it, expect } from 'vitest';
import { DEFAULT_HINTS, YaaoError } from '../../../src/log/errors.js';

const HINTED_CODES = [
  'YAAO_NOT_INITIALIZED',
  'YAAO_CONFIG_INVALID',
  'YAAO_LITERAL_SECRET',
  'YAAO_MISSING_ENV',
  'YAAO_INIT_WRITE',
  'YAAO_PLAN_NOT_FOUND',
  'YAAO_PLAN_PARSE',
  'YAAO_PLAN_INVALID',
  'YAAO_PLAN_INCLUDE_CYCLE',
  'YAAO_PLAN_INCLUDE_DEPTH',
  'YAAO_GIT',
  'YAAO_WORKTREE',
  'YAAO_AGENT_DISABLED',
  'YAAO_NO_ENABLED_AGENTS',
  'YAAO_BASE_BRANCH_MISSING',
  'YAAO_AGENT_UNAVAILABLE',
  'YAAO_PLAN_API_NO_KEY',
  'YAAO_FEATURE_BRANCH_CREATE',
];

describe('F15.4 — every documented YaaoError code has a default hint', () => {
  for (const code of HINTED_CODES) {
    it(`${code} has a non-empty default hint`, () => {
      const hint = DEFAULT_HINTS[code];
      expect(hint).toBeDefined();
      expect(hint?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it('YaaoError pulls the default hint when none is supplied', () => {
    const e = new YaaoError({ code: 'YAAO_AGENT_DISABLED', message: 'test' });
    expect(e.hint).toBe(DEFAULT_HINTS['YAAO_AGENT_DISABLED']);
  });

  it('constructor-passed hints override the default', () => {
    const e = new YaaoError({
      code: 'YAAO_AGENT_DISABLED',
      message: 'test',
      hint: 'custom hint here',
    });
    expect(e.hint).toBe('custom hint here');
  });
});
