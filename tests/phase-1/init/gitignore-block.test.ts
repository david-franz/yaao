import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';
import { GITIGNORE_BEGIN, GITIGNORE_END } from '../../../src/init/scaffold.js';

describe('.gitignore managed block', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  function gi(rel = '.gitignore'): string {
    return readFileSync(join(project!.path, rel), 'utf8');
  }

  it('appends the block when no .gitignore exists', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init']);
    const text = gi();
    expect(text).toContain(GITIGNORE_BEGIN);
    expect(text).toContain(GITIGNORE_END);
  });

  it('does not duplicate the block on a second init', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init']);
    await runCli(['--cwd', project.path, 'init']);
    const text = gi();
    const occurrences = text.split(GITIGNORE_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves user-authored content above the block', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    writeFileSync(join(project.path, '.gitignore'), 'node_modules/\nmy-secret/\n');
    await runCli(['--cwd', project.path, 'init']);
    const text = gi();
    expect(text).toContain('node_modules/');
    expect(text).toContain('my-secret/');
    expect(text).toContain(GITIGNORE_BEGIN);
  });

  it('--force replaces the existing block in place', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    writeFileSync(
      join(project.path, '.gitignore'),
      `# user line\n${GITIGNORE_BEGIN}\nstale\n${GITIGNORE_END}\n# trailing\n`,
    );
    await runCli(['--cwd', project.path, 'init', '--force']);
    const text = gi();
    expect(text).toContain('# user line');
    expect(text).toContain('# trailing');
    expect(text).not.toContain('stale');
    expect(text).toContain('.yaao/secrets.local.json');
  });

  it('--minimal skips creating .gitignore changes and .yaaoignore', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    expect(existsSync(join(project.path, '.gitignore'))).toBe(false);
    expect(existsSync(join(project.path, '.yaaoignore'))).toBe(false);
  });
});
