import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('Per-task merge.into', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('merges a completed task into the configured target branch, creating it if missing', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: mp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'mp' },
      tasks: [
        {
          id: 'a',
          title: 'Make a file',
          agent: 'claude-code',
          prompt: 'write a file',
          merge: { into: 'phase-1', 'create-if-missing': true },
        },
      ],
    });

    // Backend writes a file in the worktree so there's something to commit.
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'done' }] });
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
      runId: 'rmerge',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => writingBackend,
    });
    expect(result.status).toBe('success');

    // phase-1 should exist and contain a merge commit with hello.txt.
    const { execa } = await import('execa');
    const exists = await execa('git', ['rev-parse', '--verify', 'refs/heads/phase-1'], {
      cwd: repo.path,
      reject: false,
    });
    expect(exists.exitCode).toBe(0);
    const log = await execa('git', ['log', '--format=%s', 'phase-1'], {
      cwd: repo.path,
      reject: false,
    });
    expect(log.stdout).toMatch(/Merge mp\/a into phase-1/);
    const files = await execa('git', ['ls-tree', '-r', '--name-only', 'phase-1'], {
      cwd: repo.path,
      reject: false,
    });
    expect(files.stdout.split('\n')).toContain('hello.txt');
  });

  it('emits task:merge-failed when the target does not exist and create-if-missing is false', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: mp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'mp' },
      tasks: [
        {
          id: 'a',
          title: 'Make a file',
          agent: 'claude-code',
          prompt: 'p',
          merge: { into: 'never-created', 'create-if-missing': false },
        },
      ],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'done' }] });
    const writingBackend = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof backend.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'hi.txt'), 'hi\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const events: { type: string; reason?: string }[] = [];
    const result = await runPlan({
      runId: 'rmerge-missing',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => writingBackend,
      onProgress: (ev) => {
        if (ev.type === 'task:merge-failed' || ev.type === 'task:merged') {
          events.push({ type: ev.type, ...('reason' in ev ? { reason: ev.reason } : {}) });
        }
      },
    });

    expect(result.status).toBe('success'); // task itself succeeded
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task:merge-failed');
    expect(events[0]?.reason).toMatch(/create-if-missing is false/);
  });
});
