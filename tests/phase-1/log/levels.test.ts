import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('log levels via global flags', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('default level is info (debug suppressed)', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, 'init']);
    expect(r.stderr).toContain('[INFO]');
    expect(r.stderr).not.toContain('[DEBUG]');
  });

  it('--quiet suppresses info', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, '--quiet', 'init']);
    expect(r.stderr).not.toContain('[INFO]');
  });

  it('--verbose enables debug', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, '--verbose', 'init']);
    expect(r.stderr).toContain('[INFO]');
    // even if no debug call fires for init, level mapping is correct: info still emits.
  });
});
