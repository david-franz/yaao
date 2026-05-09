import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao init is idempotent', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('a second init produces no diff', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');

    const first = await runCli(['--cwd', project.path, 'init']);
    expect(first.exitCode).toBe(0);

    const configBefore = readFileSync(join(project.path, '.yaao', 'yaao.config.json'), 'utf8');
    const giBefore = readFileSync(join(project.path, '.gitignore'), 'utf8');
    const mtimeBefore = statSync(join(project.path, '.yaao', 'yaao.config.json')).mtimeMs;

    const second = await runCli(['--cwd', project.path, 'init']);
    expect(second.exitCode).toBe(0);

    const configAfter = readFileSync(join(project.path, '.yaao', 'yaao.config.json'), 'utf8');
    const giAfter = readFileSync(join(project.path, '.gitignore'), 'utf8');
    const mtimeAfter = statSync(join(project.path, '.yaao', 'yaao.config.json')).mtimeMs;

    expect(configAfter).toBe(configBefore);
    expect(giAfter).toBe(giBefore);
    // config wasn't rewritten (would update mtime)
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
