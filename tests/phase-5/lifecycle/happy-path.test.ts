import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('Lifecycle happy path', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('runs a single-task plan end-to-end and writes context.md', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(
      planFile,
      `plan:
  name: hp
  version: 1
tasks:
  - id: hello
    title: Say hello
    agent: claude-code
    prompt: write a hello.txt
`,
    );
    const { plan } = fakeResolved({
      plan: { name: 'hp' },
      tasks: [{ id: 'hello', title: 'Say hello', agent: 'claude-code', prompt: 'write hello.txt' }],
    });

    // FakeBackend "writes" the file on the side so the lifecycle has something to commit.
    const backend = new FakeBackend({
      events: [{ type: 'stdout', data: 'I will write a file.' }],
    });
    const writingBackend = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'hello.txt'), 'hello\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => writingBackend,
    });
    expect(result.status).toBe('success');
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'r1', 'hello', 'context.md'))).toBe(true);
    const md = readFileSync(join(repo.path, '.yaao', 'runs', 'r1', 'hello', 'context.md'), 'utf8');
    expect(md).toContain('hp/hello');
    expect(md).toContain('hello.txt');
  });
});
