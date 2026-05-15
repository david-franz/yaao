import { describe, it, expect } from 'vitest';
import { substitutePlaceholders } from '../../../src/skills/format.js';

describe('substitutePlaceholders', () => {
  it('substitutes provided values', () => {
    const out = substitutePlaceholders('Build {{thing}} for {{user}}', {
      thing: 'OAuth',
      user: 'me',
    });
    expect(out).toBe('Build OAuth for me');
  });

  it('falls back to declared defaults when a value is missing', () => {
    const out = substitutePlaceholders('Scope is {{scope}}', {}, [
      { name: 'scope', default: 'feature' },
    ]);
    expect(out).toBe('Scope is feature');
  });

  it('leaves a placeholder untouched when no value and no default exist', () => {
    const out = substitutePlaceholders('Hello {{unknown}}', {});
    expect(out).toBe('Hello {{unknown}}');
  });
});
