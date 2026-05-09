import { describe, it, expect } from 'vitest';
import { buildPrBody } from '../../../src/merge/pr.js';
import { fakeResolved } from '../../helpers/plan.js';

describe('buildPrBody', () => {
  it('embeds task id, plan name, run id, and linked tasks', () => {
    const { plan } = fakeResolved({
      plan: { name: 'pr-test' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        {
          id: 'b',
          title: 'Implement endpoint',
          agent: 'claude-code',
          prompt: 'p',
          depends: ['a'],
          description: 'Adds /v1/foo with auth + tests',
        },
      ],
    });
    const taskB = plan.tasks.find((t) => t.id === 'b');
    expect(taskB).toBeDefined();
    if (!taskB) throw new Error('unreachable');
    const body = buildPrBody(taskB, 'pr-test', 'run-x');
    expect(body).toContain('task `b`');
    expect(body).toContain('run `run-x`');
    expect(body).toContain('`pr-test`');
    expect(body).toContain('Adds /v1/foo with auth + tests');
    expect(body).toContain('Depends on: `a`');
  });
});
