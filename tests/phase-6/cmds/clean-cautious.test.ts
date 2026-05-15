import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('yaao clean (cautious default)', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('removes only branches when --branches-only is set', async () => {
    repo = createTestRepo();
    await runCli(['--cwd', repo.path, 'init', '--minimal']);

    // Create a branch the clean command should be willing to delete.
    const { execa } = await import('execa');
    await execa('git', ['branch', 'cl/a', 'main'], { cwd: repo.path });

    // Hand-write a summary saying task a completed on branch cl/a.
    const summaryPath = join(repo.path, '.yaao', 'runs', 'r1.summary.json');
    mkdirSync(join(repo.path, '.yaao', 'runs'), { recursive: true });
    writeFileSync(
      summaryPath,
      JSON.stringify({
        runId: 'r1',
        planFile: 'plan.yaml',
        planHash: 'h',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        status: 'success',
        tasks: { a: { status: 'completed', branch: 'cl/a' } },
      }),
    );

    const r = await runCli(['--cwd', repo.path, '--json', 'clean', 'r1', '--branches-only', '--force']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { branchesRemoved: number; worktreesRemoved: number };
    expect(out.branchesRemoved).toBe(1);
    expect(out.worktreesRemoved).toBe(0);
    // Branch should be gone.
    const exists = await execa('git', ['rev-parse', '--verify', 'refs/heads/cl/a'], {
      cwd: repo.path,
      reject: false,
    });
    expect(exists.exitCode).not.toBe(0);
    // The summary file is left in place.
    expect(existsSync(summaryPath)).toBe(true);
  });
});
