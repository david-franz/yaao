import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('yaao clean on failed runs', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('cleans a failed run when given an explicit run id', async () => {
    repo = createTestRepo();
    await runCli(['--cwd', repo.path, 'init', '--minimal']);

    // A branch that was left behind by the failed run.
    const { execa } = await import('execa');
    await execa('git', ['branch', 'demo/scaffold', 'main'], { cwd: repo.path });

    // Hand-write a summary saying the run failed after scaffold ran on demo/scaffold.
    mkdirSync(join(repo.path, '.yaao', 'runs', 'rfail'), { recursive: true });
    writeFileSync(
      join(repo.path, '.yaao', 'runs', 'rfail', 'summary.json'),
      JSON.stringify({
        runId: 'rfail',
        planFile: 'plan.yaml',
        planHash: 'h',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        status: 'failed',
        tasks: { scaffold: { status: 'failed', branch: 'demo/scaffold' } },
      }),
    );

    const r = await runCli(['--cwd', repo.path, '--json', 'clean', 'rfail', '--branches-only', '--force']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { branchesRemoved: number };
    expect(out.branchesRemoved).toBe(1);
    const after = await execa('git', ['rev-parse', '--verify', 'refs/heads/demo/scaffold'], {
      cwd: repo.path,
      reject: false,
    });
    expect(after.exitCode).not.toBe(0);
  });

  it('wipes the run directory so subsequent runs do not need --force', async () => {
    repo = createTestRepo();
    await runCli(['--cwd', repo.path, 'init', '--minimal']);
    const { execa } = await import('execa');
    await execa('git', ['branch', 'demo/scaffold', 'main'], { cwd: repo.path });

    const runDir = join(repo.path, '.yaao', 'runs', 'rwipe');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'summary.json'),
      JSON.stringify({
        runId: 'rwipe',
        planFile: 'plan.yaml',
        planHash: 'h',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        status: 'failed',
        tasks: { scaffold: { status: 'failed', branch: 'demo/scaffold' } },
      }),
    );
    // Stash an output log so we can confirm it's also gone.
    writeFileSync(join(runDir, 'scaffold-output.log'), 'leftover');

    const r = await runCli(['--cwd', repo.path, '--json', 'clean', 'rwipe', '--force']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { journalsRemoved: number };
    expect(out.journalsRemoved).toBe(1);
    const { existsSync } = await import('node:fs');
    expect(existsSync(runDir)).toBe(false);
  });

  it('--all --keep-failed still skips failed runs', async () => {
    repo = createTestRepo();
    await runCli(['--cwd', repo.path, 'init', '--minimal']);
    const { execa } = await import('execa');
    await execa('git', ['branch', 'demo/scaffold', 'main'], { cwd: repo.path });

    mkdirSync(join(repo.path, '.yaao', 'runs', 'rfail'), { recursive: true });
    writeFileSync(
      join(repo.path, '.yaao', 'runs', 'rfail', 'summary.json'),
      JSON.stringify({
        runId: 'rfail',
        planFile: 'plan.yaml',
        planHash: 'h',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:01Z',
        status: 'failed',
        tasks: { scaffold: { status: 'failed', branch: 'demo/scaffold' } },
      }),
    );

    const r = await runCli([
      '--cwd', repo.path, '--json', 'clean', '--all', '--keep-failed', '--branches-only', '--force',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { branchesRemoved: number };
    expect(out.branchesRemoved).toBe(0);
    const after = await execa('git', ['rev-parse', '--verify', 'refs/heads/demo/scaffold'], {
      cwd: repo.path,
      reject: false,
    });
    expect(after.exitCode).toBe(0);
  });
});
