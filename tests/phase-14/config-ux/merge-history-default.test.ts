import { describe, it, expect } from 'vitest';
import { ConfigSchema, DEFAULT_CONFIG } from '../../../src/config/schema.js';

describe('F14.8 — merge.history default flipped to rebase', () => {
  it('DEFAULT_CONFIG.merge.history is rebase', () => {
    expect(DEFAULT_CONFIG.merge.history).toBe('rebase');
  });

  it('parsing an empty merge block resolves to rebase', () => {
    const parsed = ConfigSchema.parse({ version: 1 });
    expect(parsed.merge.history).toBe('rebase');
  });

  it('explicit history: merge still wins', () => {
    const parsed = ConfigSchema.parse({ version: 1, merge: { history: 'merge' } });
    expect(parsed.merge.history).toBe('merge');
  });
});
