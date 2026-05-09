import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend } from '../../../src/agents/backend.js';

describe('Lifecycle context passing', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('downstream task receives upstream context.md as a prompt prefix', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(
      planFile,
      `plan: { name: cp, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: write a.txt
  - id: b
    title: B
    agent: claude-code
    prompt: write b.txt that reads a.txt
    depends: [a]
`,
    );
    const { plan } = fakeResolved({
      plan: { name: 'cp' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'write a.txt' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'write b.txt', depends: ['a'] },
      ],
    });

    const observed: { id: string; prompt: string }[] = [];
    const makeBackend = (id: string): AgentBackend => {
      const inner = new FakeBackend({
        events: [{ type: 'stdout', data: `worked on ${id}` }],
      });
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

    const result = await runPlan({
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: (task) => makeBackend(task.id),
    });
    expect(result.status).toBe('success');
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'r1', 'a', 'context.md'))).toBe(true);

    // Task a's prompt is unchanged. Task b's prompt should contain the prefix referencing a.
    const aPrompt = observed.find((o) => o.id === 'a')?.prompt ?? '';
    const bPrompt = observed.find((o) => o.id === 'b')?.prompt ?? '';
    expect(aPrompt).not.toContain('Context from prior tasks');
    expect(bPrompt).toContain('Context from prior tasks');
    expect(bPrompt).toContain('task: a');

    // Sanity: the upstream context.md captures the file change.
    const md = readFileSync(join(repo.path, '.yaao', 'runs', 'r1', 'a', 'context.md'), 'utf8');
    expect(md).toContain('a.txt');
  });
});
