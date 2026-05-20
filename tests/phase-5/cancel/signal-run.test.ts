import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { signalRun } from '../../../src/exec/signal-run.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('signalRun — cross-process cancel for a running yaao run', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('returns no-pid-file when runner.pid is absent', () => {
    project = createTmpProject();
    const r = signalRun({ cwd: project.path, runId: 'doesnt-exist' });
    expect(r.signaled).toBe(false);
    expect(r.reason).toBe('no-pid-file');
  });

  it('returns pid-dead when the pid file points at a process that no longer exists', () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    // Pid 999999999 is well outside the realistic range — kill(pid, 0)
    // returns ESRCH. The helper should report 'pid-dead', not throw.
    writeFileSync(join(runDir, 'runner.pid'), '999999999\n');
    const r = signalRun({ cwd: project.path, runId: 'r1' });
    expect(r.signaled).toBe(false);
    expect(r.reason).toBe('pid-dead');
    expect(r.pid).toBe(999999999);
  });

  it('returns no-pid-file when the file is empty / malformed', () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r2');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'runner.pid'), 'not a number\n');
    const r = signalRun({ cwd: project.path, runId: 'r2' });
    expect(r.signaled).toBe(false);
    expect(r.reason).toBe('no-pid-file');
  });

  it('actually signals the targeted process and the SIGTERM handler fires', async () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r3');
    mkdirSync(runDir, { recursive: true });
    // Spawn a long-lived node child that exits on SIGTERM with a known
    // exit code so we can confirm the signal was delivered + handled.
    // The child writes "ready" to stdout AFTER installing the handler so
    // the test waits for the handler to be live before signaling — without
    // this, the SIGTERM can race the handler registration and the child
    // exits via default (exitCode=null, signal=SIGTERM) instead of 42.
    const child = execa(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(42)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ],
      { reject: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((res) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('ready')) res();
      });
    });
    writeFileSync(join(runDir, 'runner.pid'), `${child.pid}\n`);
    const r = signalRun({ cwd: project.path, runId: 'r3' });
    expect(r.signaled).toBe(true);
    expect(r.reason).toBe('sent');
    expect(r.pid).toBe(child.pid);
    const result = await child;
    expect(result.exitCode).toBe(42);
  });
});
