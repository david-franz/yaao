import { describe, it, expect } from 'vitest';
import {
  YaaoError,
  NotInitializedError,
  ConfigValidationError,
  LiteralSecretError,
  MissingEnvError,
  InitWriteError,
  DEFAULT_HINTS,
} from '../../../src/log/errors.js';

describe('error catalogue and default hints', () => {
  it('every typed subclass carries its expected code', () => {
    expect(new NotInitializedError({ message: 'm' }).code).toBe('YAAO_NOT_INITIALIZED');
    expect(new ConfigValidationError({ message: 'm' }).code).toBe('YAAO_CONFIG_INVALID');
    expect(new LiteralSecretError({ message: 'm', file: 'f', jsonPath: 'p' }).code).toBe(
      'YAAO_LITERAL_SECRET',
    );
    expect(new MissingEnvError({ message: 'm', varName: 'X' }).code).toBe('YAAO_MISSING_ENV');
    expect(new InitWriteError({ message: 'm', path: '/x' }).code).toBe('YAAO_INIT_WRITE');
  });

  it('hints come from DEFAULT_HINTS unless overridden', () => {
    const e = new NotInitializedError({ message: 'm' });
    expect(e.hint).toBe(DEFAULT_HINTS['YAAO_NOT_INITIALIZED']);
    const o = new YaaoError({ code: 'YAAO_NOT_INITIALIZED', message: 'm', hint: 'override me' });
    expect(o.hint).toBe('override me');
  });

  it('MissingEnvError synthesizes a hint that includes the var name', () => {
    const e = new MissingEnvError({ message: 'm', varName: 'WHATEVER' });
    expect(e.hint).toContain('WHATEVER');
  });

  it('YaaoError name reflects the constructed subclass', () => {
    expect(new InitWriteError({ message: 'm', path: '/x' }).name).toBe('InitWriteError');
  });
});
