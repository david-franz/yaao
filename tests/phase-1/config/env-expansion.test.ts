import { describe, it, expect } from 'vitest';
import { expandEnv } from '../../../src/config/loader.js';
import { MissingEnvError } from '../../../src/log/errors.js';

describe('expandEnv', () => {
  it('expands ${VAR} when present', () => {
    expect(expandEnv({ key: '${SECRET}' }, { SECRET: 'shh' })).toEqual({ key: 'shh' });
  });

  it('throws MissingEnvError on unresolved var', () => {
    expect(() => expandEnv({ key: '${MISSING}' }, {})).toThrow(MissingEnvError);
  });

  it('leaves non-matching strings alone', () => {
    expect(expandEnv({ key: 'plain string' }, {})).toEqual({ key: 'plain string' });
    expect(expandEnv({ key: '${not a var}' }, {})).toEqual({ key: '${not a var}' });
  });

  it('walks arrays and objects recursively', () => {
    const out = expandEnv({ a: ['${X}', { b: '${Y}' }] }, { X: '1', Y: '2' });
    expect(out).toEqual({ a: ['1', { b: '2' }] });
  });

  it('reports the var name in the error', () => {
    try {
      expandEnv({ a: { b: '${OOPS}' } }, {});
    } catch (e) {
      expect((e as MissingEnvError).varName).toBe('OOPS');
      expect((e as MissingEnvError).message).toContain('OOPS');
      return;
    }
    throw new Error('expected MissingEnvError');
  });
});
