import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../../src/exec/scheduler.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('Scheduler: priority', () => {
  it('readyTasks orders by descendant count then lexicographic', () => {
    const { plan } = fakeResolved({
      tasks: [
        { id: 'leaf-z', title: 'Z', agent: 'claude-code', prompt: 'hi' },
        { id: 'critical', title: 'C', agent: 'claude-code', prompt: 'hi' },
        { id: 'd1', title: 'D1', agent: 'claude-code', prompt: 'hi', depends: ['critical'] },
        { id: 'd2', title: 'D2', agent: 'claude-code', prompt: 'hi', depends: ['critical'] },
        { id: 'leaf-a', title: 'A', agent: 'claude-code', prompt: 'hi' },
      ],
    });
    const s = new Scheduler({ plan, maxParallel: 4 });
    const ready = s.readyTasks();
    // 'critical' has 2 descendants and should come first.
    expect(ready[0]).toBe('critical');
    // 'leaf-a' and 'leaf-z' tie on 0 descendants — lex order picks leaf-a first.
    const restAfterCritical = ready.slice(1);
    expect(restAfterCritical.indexOf('leaf-a')).toBeLessThan(restAfterCritical.indexOf('leaf-z'));
  });
});
