import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao stop', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('JSON: reports no-pid-file for a run that never started / has no pid', async () => {
    project = createTmpProject();
    // Manually scaffold a run dir with NO runner.pid — mirrors a run that
    // ended cleanly (pid file unlinked) or one started before pid tracking
    // landed.
    mkdirSync(join(project.path, '.yaao', 'runs', 'r1'), { recursive: true });
    writeFileSync(
      join(project.path, '.yaao', 'runs', 'r1', 'journal.jsonl'),
      JSON.stringify({ t: 'run:start', time: '2026-05-20T12:00:00.000Z', runId: 'r1', planFile: '/x', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } }) + '\n',
    );
    const r = await runCli(['--cwd', project.path, '--json', 'stop', 'r1']);
    const parsed = JSON.parse(r.stdout) as { runId: string; signaled: boolean; reason: string };
    expect(parsed.runId).toBe('r1');
    expect(parsed.signaled).toBe(false);
    expect(parsed.reason).toBe('no-pid-file');
    expect(r.exitCode).toBe(1);
  });

  it('JSON: reports pid-dead for a stale runner.pid', async () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r2');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'journal.jsonl'),
      JSON.stringify({ t: 'run:start', time: '2026-05-20T12:00:00.000Z', runId: 'r2', planFile: '/x', planHash: 'h', config: { baseBranch: 'main', maxParallel: 1 } }) + '\n',
    );
    writeFileSync(join(runDir, 'runner.pid'), '999999999\n');
    const r = await runCli(['--cwd', project.path, '--json', 'stop', 'r2']);
    const parsed = JSON.parse(r.stdout) as { signaled: boolean; reason: string; pid: number };
    expect(parsed.signaled).toBe(false);
    expect(parsed.reason).toBe('pid-dead');
    expect(parsed.pid).toBe(999999999);
    expect(r.exitCode).toBe(1);
  });

  it('errors when no run id is given and no runs exist', async () => {
    project = createTmpProject();
    const r = await runCli(['--cwd', project.path, 'stop']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no running runs to stop/);
  });
});
