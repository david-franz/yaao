import { describe, it, expect } from 'vitest';
import { generateRunId } from '../../../src/exec/run-id.js';

describe('F16.1 — generateRunId() entropy', () => {
  it('emits a string starting with run-', () => {
    expect(generateRunId()).toMatch(/^run-/);
  });

  it('two ids generated back-to-back are distinct', () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
  });

  it("1000 ids generated in a tight loop are all distinct (no millisecond collision)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRunId());
    }
    expect(ids.size).toBe(1000);
  });

  it('the suffix is file-path-safe (no slashes, spaces, quotes)', () => {
    const id = generateRunId();
    expect(id).not.toMatch(/[\s/'"\\]/);
  });

  it('the shape is run-<base36-ms>-<nanoid6>', () => {
    const id = generateRunId();
    // run-<base36>-<6 chars>. nanoid uses [A-Za-z0-9_-]
    expect(id).toMatch(/^run-[a-z0-9]+-[A-Za-z0-9_-]{6}$/);
  });
});
