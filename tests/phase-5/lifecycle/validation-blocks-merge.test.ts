import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend } from '../../../src/agents/backend.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { loadRun } from '../../../src/git/journal.js';

function writingBackend(filename: string): AgentBackend {
  const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'spawn') {
        return async (opts: Parameters<typeof inner.spawn>[0]) => {
          writeFileSync(join(opts.cwd, filename), 'work\n');
          return target.spawn(opts);
        };
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

describe('validation must block auto-merge (regression for asymmetric enforcement)', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('a task whose `make && nm <missing> | grep <pat>` validation fails never merges to base', async () => {
    repo = createTestRepo();
    // A Makefile that succeeds verbosely but never produces build/kernel.elf,
    // matching the macOS host the reviewer hit. The agent's work is real
    // (`writingBackend` creates a file) so `taskMadeProgress` is true and the
    // merge gate becomes the only thing standing between the task and main.
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(
      join(repo.path, 'Makefile'),
      [
        'all:',
        '\t@echo "building objects (no ELF linker available)"',
        '\t@mkdir -p build',
        '\t@touch build/os.iso',
        '\t@echo "cp build/os.iso os.iso"',
      ].join('\n'),
    );
    repo.commit('seed Makefile');
    const baseShaBefore = repo.run(['rev-parse', 'main']).stdout.trim();

    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vbm\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'vbm' },
      config: { merge: { strategy: 'auto' as const } },
      tasks: [
        {
          id: 't',
          title: 'T',
          agent: 'claude-code',
          prompt: 'p',
          // The exact failing pattern from the reviewer's run. make exits 0
          // with verbose output; nm errors because build/kernel.elf doesn't
          // exist; grep gets empty stdin and exits 1; pipefail propagates.
          validation: {
            command: "make && nm build/kernel.elf | grep -E 'kheap_init'",
            'must-pass': true,
          },
        },
      ],
    });
    const r = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'vbm1',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      backendFor: () => writingBackend('a.txt'),
    });

    // 1. The run failed — the verdict on the task is `failed`, not `completed`.
    expect(r.status).toBe('failed');

    // 2. base-branch did NOT move. This is the core invariant — even with
    //    merge.strategy=auto, a failing-validation task must not land on main.
    const baseShaAfter = repo.run(['rev-parse', 'main']).stdout.trim();
    expect(baseShaAfter).toBe(baseShaBefore);

    // 3. The summary records the actual validation verdict shape: exit code
    //    captured and `decisionReason: 'exit-code'` so future inspection can
    //    answer "why did yaao decide this?" from the journal alone.
    const { summary } = await loadRun('vbm1', join(repo.path, '.yaao', 'runs'));
    const t = summary.tasks['t'];
    expect(t?.status).toBe('failed');
    expect(t?.mergeStatus).toBeUndefined();
    expect(t?.validation?.command).toContain('nm build/kernel.elf');
  });

  it('a passing-validation task records exit-code + decisionReason on task:completed', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: vbm\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'vbm' },
      tasks: [
        {
          id: 't',
          title: 'T',
          agent: 'claude-code',
          prompt: 'p',
          validation: { command: "echo hi | grep hi", 'must-pass': true },
        },
      ],
    });
    const r = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'vbm2',
      plan,
      planFile,
      rootDir: repo.path,
      config: DEFAULT_CONFIG,
      noMerge: true,
      backendFor: () => writingBackend('a.txt'),
    });
    expect(r.status).toBe('success');
    const { summary } = await loadRun('vbm2', join(repo.path, '.yaao', 'runs'));
    const v = summary.tasks['t']?.validation;
    expect(v?.exitCode).toBe(0);
    expect(v?.decisionReason).toBe('exit-code');
    expect(v?.mustPass).toBe(true);
  });
});
