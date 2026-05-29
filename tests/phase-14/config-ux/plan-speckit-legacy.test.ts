import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../../src/config/schema.js';
import { buildDefaultConfigJson } from '../../../src/init/scaffold.js';

describe('F14.8 — plan.speckit legacy handling', () => {
  it('configs with the legacy plan.speckit: false still parse', () => {
    const config = ConfigSchema.parse({
      version: 1,
      plan: { format: 'markdown', speckit: false },
    });
    // The field round-trips but is otherwise unused.
    expect(config.plan.format).toBe('markdown');
  });

  it('new scaffolds do not write plan.speckit', () => {
    const body = buildDefaultConfigJson();
    expect(body).not.toMatch(/"speckit"/);
  });
});
