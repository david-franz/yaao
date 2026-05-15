import { describe, it, expect } from 'vitest';
import { suggestScope } from '../../../src/planner/scope.js';

describe('suggestScope', () => {
  it('classifies short add-a-feature descriptions as feature', () => {
    const s = suggestScope('Add Google sign-in to /auth');
    expect(s.scope).toBe('feature');
  });

  it('classifies platform/migrate language as project', () => {
    expect(suggestScope('Rewrite the auth platform from scratch').scope).toBe('project');
    expect(suggestScope('Migrate the data layer to the new schema').scope).toBe('project');
  });

  it('treats very long descriptions as project', () => {
    const long = 'lorem '.repeat(80);
    expect(suggestScope(long).scope).toBe('project');
  });
});
