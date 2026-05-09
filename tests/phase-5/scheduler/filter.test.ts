import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: filter modes', () => {
  function build() {
    return fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi' },
      ],
    });
  }

  it('--only includes the chosen task and its deps', () => {
    const { plan } = build();
    const s = new Scheduler({ plan, maxParallel: 4, filter: { only: ['b'] } });
    // a has no deps so it transitions ready immediately; b waits; c is filtered out.
    expect(s.snapshot()).toMatchObject({ a: 'ready', b: 'pending', c: 'skipped' });
  });

  it('--skip skips the chosen task and downstream', () => {
    const { plan } = build();
    const s = new Scheduler({ plan, maxParallel: 4, filter: { skip: ['a'] } });
    // c has no deps so it transitions ready immediately.
    expect(s.snapshot()).toMatchObject({ a: 'skipped', b: 'skipped', c: 'ready' });
  });

  it('--only and --skip together are rejected', () => {
    const { plan } = build();
    expect(() => new Scheduler({ plan, maxParallel: 1, filter: { only: ['a'], skip: ['c'] } })).toThrow();
  });
});
