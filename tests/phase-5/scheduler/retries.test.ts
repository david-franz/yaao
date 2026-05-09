import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { YaaoError } from '../../../src/log/errors.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: retries', () => {
  it('a failed task with retries left is parked pending; retryTask makes it ready', () => {
    const { plan } = fakeResolved({
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', retries: 1 }],
    });
    const s = new Scheduler({ plan, maxParallel: 1 });
    s.startTask('a');
    s.failTask('a', new YaaoError({ code: 'X', message: 'boom' }));
    // Parked at pending; explicit retryTask is the ack.
    expect(s.snapshot()['a']).toBe('pending');
    expect(s.readyTasks()).toEqual([]);
    s.retryTask('a');
    expect(s.readyTasks()).toEqual(['a']);
    s.startTask('a');
    s.failTask('a', new YaaoError({ code: 'X', message: 'boom again' }));
    // Out of retries: terminally failed.
    expect(s.snapshot()['a']).toBe('failed');
    expect(s.done()).toBe(true);
  });
});
