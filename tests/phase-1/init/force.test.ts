import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao init --force', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('resets a modified config to defaults', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');

    const first = await runCli(['--cwd', project.path, 'init']);
    expect(first.exitCode).toBe(0);

    const configPath = join(project.path, '.yaao', 'yaao.config.json');
    writeFileSync(configPath, '{"user-edited": true}');

    const forced = await runCli(['--cwd', project.path, 'init', '--force']);
    expect(forced.exitCode).toBe(0);

    const reset = JSON.parse(readFileSync(configPath, 'utf8')) as { version: number };
    expect(reset.version).toBe(1);
  });
});
