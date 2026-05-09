import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao init in a non-git directory', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('succeeds, warns, and skips .gitignore', async () => {
    project = createTmpProject();
    // intentionally no .git/

    const r = await runCli(['--cwd', project.path, 'init']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project.path, '.yaao', 'yaao.config.json'))).toBe(true);
    expect(existsSync(join(project.path, '.gitignore'))).toBe(false);
    expect(r.stderr).toMatch(/not a git repo/i);
  });
});
