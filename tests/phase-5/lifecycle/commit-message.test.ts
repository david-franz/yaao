import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('commit message body', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('uses a subject-only commit message, never the raw stdout transcript', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: cm\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'cm' },
      tasks: [{ id: 'a', title: 'A demo task', agent: 'claude-code', prompt: 'p' }],
    });

    // Agent emits a long stdout chunk that *would* be included if the
    // lifecycle still dropped stdout into the commit body.
    const noisyTranscript = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ type: 'tool_use', i, blob: 'x'.repeat(200) }),
    ).join('\n');
    const backend = new FakeBackend({
      events: [{ type: 'stdout', data: noisyTranscript }],
    });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'made.txt'), 'hi\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rcm',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // Look at the task branch's tip — that's the agent/lifecycle commit.
    // (main's tip is the auto-merge commit on top of it.)
    const message = execaSync('git', ['log', '-1', '--format=%B', 'cm/a'], { cwd: repo.path })
      .stdout
      .trim();
    expect(message).toBe('[a] A demo task');
    expect(message).not.toContain('tool_use');
    expect(message).not.toContain('xxxx');
  });
});
