import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend } from '../../../src/agents/backend.js';

describe('inherit-dep-context', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  function buildPlanWithDownstreamOptOut(optOut: boolean) {
    const { plan } = fakeResolved({
      plan: { name: 'idc' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'write a' },
        {
          id: 'b',
          title: 'B',
          agent: 'claude-code',
          prompt: 'write b',
          depends: ['a'],
          ...(optOut ? { 'inherit-dep-context': false } : {}),
        },
      ],
    });
    return plan;
  }

  function makeBackend(observed: { id: string; prompt: string }[]): (id: string) => AgentBackend {
    return (id: string) => {
      const inner = new FakeBackend({ events: [{ type: 'stdout', data: `did ${id}` }] });
      return new Proxy(inner, {
        get(target, prop) {
          if (prop === 'spawn') {
            return async (opts: Parameters<typeof inner.spawn>[0]) => {
              observed.push({ id, prompt: opts.prompt });
              writeFileSync(join(opts.cwd, `${id}.txt`), `${id}\n`);
              return target.spawn(opts);
            };
          }
          return Reflect.get(target, prop) as unknown;
        },
      });
    };
  }

  it('default-on: downstream task sees the dep-context preamble', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: idc\n  version: 1\ntasks: []\n');
    const plan = buildPlanWithDownstreamOptOut(false);
    const observed: { id: string; prompt: string }[] = [];
    await runPlan({
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: (task) => makeBackend(observed)(task.id),
    });
    const bPrompt = observed.find((o) => o.id === 'b')?.prompt ?? '';
    expect(bPrompt).toContain('Context from prior tasks');
    expect(bPrompt).toContain('task: a');
  });

  it('opt-out: when inherit-dep-context is false, the preamble is omitted', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: idc\n  version: 1\ntasks: []\n');
    const plan = buildPlanWithDownstreamOptOut(true);
    const observed: { id: string; prompt: string }[] = [];
    await runPlan({
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: (task) => makeBackend(observed)(task.id),
    });
    const bPrompt = observed.find((o) => o.id === 'b')?.prompt ?? '';
    expect(bPrompt).not.toContain('Context from prior tasks');
    expect(bPrompt).not.toContain('task: a');
  });
});
