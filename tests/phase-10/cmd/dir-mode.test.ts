import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const MD = (id: string, title: string) => `# ${title}

> body

## Tasks

| id | title | depends |
|----|-------|---------|
| ${id} | ${title} |         |

## ${id} — ${title}

prose
`;

describe('yaao convert: directory mode', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('walks a directory of plans and emits one YAML per plan', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    project.write('.yaao/plans/oauth.md', MD('a', 'A'));
    project.write('.yaao/plans/phases/phase-1.md', MD('b', 'B'));
    project.write('.yaao/plans/phases/phase-2.md', MD('c', 'C'));

    const r = await runCli(['--cwd', project.path, '--json', 'convert', '.yaao/plans']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { results: { outPath: string }[] };
    expect(parsed.results).toHaveLength(3);
    expect(existsSync(join(project.path, '.yaao', 'exec', 'oauth.yaml'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'exec', 'phase-1.yaml'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'exec', 'phase-2.yaml'))).toBe(true);
  });

  it('with no argument, defaults to plan.out-dir from config', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    project.write('.yaao/plans/only.md', MD('a', 'A'));
    const r = await runCli(['--cwd', project.path, '--json', 'convert']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project.path, '.yaao', 'exec', 'only.yaml'))).toBe(true);
  });
});
