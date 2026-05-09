import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: diamond DAG', () => {
  it('walks a → (b, c) → d in topological order', () => {
    const { plan } = fakeResolved({
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'hi' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'hi', depends: ['a'] },
        { id: 'd', title: 'D', agent: 'claude-code', prompt: 'hi', depends: ['b', 'c'] },
      ],
    });
    const s = new Scheduler({ plan, maxParallel: 4 });
    expect(s.readyTasks()).toEqual(['a']);
    s.startTask('a');
    s.completeTask('a', {});
    expect(s.readyTasks().sort()).toEqual(['b', 'c']);
    s.startTask('b');
    s.startTask('c');
    s.completeTask('b', {});
    s.completeTask('c', {});
    expect(s.readyTasks()).toEqual(['d']);
    s.startTask('d');
    s.completeTask('d', {});
    expect(s.done()).toBe(true);
  });
});
