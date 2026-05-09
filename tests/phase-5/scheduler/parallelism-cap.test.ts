import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: parallelism cap', () => {
  it('readyTasks respects maxParallel - active', () => {
    const { plan } = fakeResolved({
      tasks: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        title: `T${i}`,
        agent: 'claude-code' as const,
        prompt: 'hi',
      })),
    });
    const s = new Scheduler({ plan, maxParallel: 3 });
    expect(s.readyTasks()).toHaveLength(3);
    s.startTask(s.readyTasks()[0] as string);
    expect(s.readyTasks()).toHaveLength(2);
    s.startTask(s.readyTasks()[0] as string);
    expect(s.readyTasks()).toHaveLength(1);
    s.startTask(s.readyTasks()[0] as string);
    expect(s.readyTasks()).toEqual([]);
  });
});
