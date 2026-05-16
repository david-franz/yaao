import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { YaaoError } from '../../../src/log/errors.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: failTask is terminal', () => {
  // Retry policy moved out of the scheduler and into the lifecycle (which owns
  // the worktree it would have to re-spawn the agent against). The scheduler
  // therefore always treats failTask as terminal — by the time it's called,
  // the lifecycle has already exhausted whatever retries the task declared.
  // Retry semantics are covered by tests/phase-5/lifecycle/retry.test.ts.
  it('marks the task failed and cascade-skips downstream regardless of task.retries', () => {
    const { plan } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi', retries: 3 },
        { id: 'b', title: 'B', agent: 'claude-code', depends: ['a'], prompt: 'after a' },
      ],
    });
    const s = new Scheduler({ plan, maxParallel: 1 });
    s.startTask('a');
    s.failTask('a', new YaaoError({ code: 'X', message: 'boom' }));
    expect(s.snapshot()['a']).toBe('failed');
    expect(s.snapshot()['b']).toBe('skipped');
    expect(s.done()).toBe(true);
  });
});
