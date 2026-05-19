import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend } from '../../../src/agents/backend.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

function writingBackend(): AgentBackend {
  const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'spawn') {
        return async (opts: Parameters<typeof inner.spawn>[0]) => {
          writeFileSync(join(opts.cwd, 'a.txt'), 'hi\n');
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('validation command is run under pipefail', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('a non-existent command in the middle of a pipe fails the validation', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'vp' },
      tasks: [
        {
          id: 't',
          title: 'T',
          agent: 'claude-code',
          prompt: 'p',
          // Mirrors the real-world `make && nm build/kernel.elf | grep …`
          // pattern: the first part succeeds (true), the middle part fails
          // (nm on a non-existent file), the last part (grep) consumes empty
          // stdin and exits 1 either way. Under default `sh -c …` semantics
          // grep's exit code is what matters; the asymmetric validation
          // outcomes the reviewer saw came from that. With pipefail on, the
          // failure of the middle command is what surfaces — same exit code
          // every time.
          validation: {
            command: 'true && nm /definitely/does/not/exist 2>/dev/null | grep -E foo',
            'must-pass': true,
          },
        },
      ],
    });
    const r = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'vp1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      noMerge: true,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('failed');
  });

  it('a passing validation still passes', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'vp' },
      tasks: [
        {
          id: 't',
          title: 'T',
          agent: 'claude-code',
          prompt: 'p',
          validation: { command: 'echo hi | grep hi', 'must-pass': true },
        },
      ],
    });
    const r = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'vp2',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      noMerge: true,
      backendFor: () => writingBackend(),
    });
    expect(r.status).toBe('success');
  });
});
