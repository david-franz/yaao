import { describe, it, expect } from 'vitest';
import { PlanSchema } from '../../../src/plan/schema/plan.js';

describe('PlanSchema invalid cases', () => {
  it('rejects a task with both prompt and prompt-ref', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', 'prompt-ref': './p.md' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a task with neither prompt nor prompt-ref', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [],
      unknown: 'nope',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid task id (uppercase)', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [{ id: 'BadId', title: 'X', agent: 'claude-code', prompt: 'hi' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects agent: api without an api binding', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [{ id: 'a', title: 'A', agent: 'api', prompt: 'hi' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid duration string', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'p', version: 1 },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', timeout: 'forever' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-slug plan name', () => {
    const r = PlanSchema.safeParse({
      plan: { name: 'Bad Name', version: 1 },
      tasks: [],
    });
    expect(r.success).toBe(false);
  });
});
