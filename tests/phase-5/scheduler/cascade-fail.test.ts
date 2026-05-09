import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { YaaoError } from '../../../src/log/errors.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: cascade-fail', () => {
  it('skips downstream tasks when an upstream task fails', () => {
    const { plan } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['b'] },
      ],
    });
    const s = new Scheduler({ plan, maxParallel: 4 });
    s.startTask('a');
    s.failTask('a', new YaaoError({ code: 'X', message: 'boom' }));
    expect(s.snapshot()).toEqual({ a: 'failed', b: 'skipped', c: 'skipped' });
    expect(s.done()).toBe(true);
  });
});
