import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('yaao merge: happy path', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('runs to completion via init → run → merge', async () => {
    repo = createTestRepo();
    const planPath = 'plan.yaml';
    // Set up a yaao project so the run journal lands in the right place.
    await runCli(['--cwd', repo.path, 'init', '--minimal']);

    // Build a branch with a real change first, then return to main and write the plan
    // file there (so it survives the checkout dance).
    const { execa } = await import('execa');
    await execa('git', ['checkout', '-q', '-b', 'mh/a'], { cwd: repo.path });
    writeFileSync(join(repo.path, 'a.txt'), 'a\n');
    repo.commit('a writes');
    await execa('git', ['checkout', '-q', 'main'], { cwd: repo.path });

    writeFileSync(
      join(repo.path, planPath),
      `plan: { name: mh, version: 1 }
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt: write a.txt
`,
    );

    // Hand-write a journal that the merge command can consume.
    const journalDir = join(repo.path, '.yaao', 'runs');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      join(journalDir, 'manual.jsonl'),
      [
        JSON.stringify({ t: 'run:start', time: '2026-01-01T00:00:00Z', runId: 'manual', planFile: join(repo.path, planPath), planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } }),
        JSON.stringify({ t: 'task:queued', time: '2026-01-01T00:00:01Z', taskId: 'a', depends: [] }),
        JSON.stringify({ t: 'task:running', time: '2026-01-01T00:00:02Z', taskId: 'a', agent: 'claude-code', worktree: '/x', branch: 'mh/a', pid: 0 }),
        JSON.stringify({ t: 'task:completed', time: '2026-01-01T00:00:03Z', taskId: 'a', durationMs: 1, filesChanged: 1, commit: 'sha' }),
        JSON.stringify({ t: 'run:end', time: '2026-01-01T00:00:04Z', status: 'success', durationMs: 4 }),
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(journalDir, 'manual.summary.json'),
      JSON.stringify({
        runId: 'manual',
        planFile: join(repo.path, planPath),
        planHash: 'h',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:04Z',
        status: 'success',
        tasks: { a: { status: 'completed', agent: 'claude-code', branch: 'mh/a' } },
      }),
    );

    const r = await runCli(['--cwd', repo.path, '--json', 'merge', 'manual']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { merged: string[]; conflicts: unknown[] };
    expect(out.merged).toContain('a');
    expect(out.conflicts).toEqual([]);
  });
});
