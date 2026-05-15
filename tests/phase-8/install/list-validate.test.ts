import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao skills list / validate', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('list reports discovered project skills', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    project.write(
      '.yaao/skills/sample/skill.yaml',
      'name: sample\nversion: 1\ndescription: A sample skill\n',
    );
    project.write('.yaao/skills/sample/prompt.md', 'do it');
    const r = await runCli(['--cwd', project.path, '--json', 'skills', 'list']);
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout) as { name: string; source: string }[];
    expect(rows.find((x) => x.name === 'sample')).toBeDefined();
  });

  it('validate catches undeclared placeholders', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    project.write(
      '.yaao/skills/badph/skill.yaml',
      'name: badph\nversion: 1\ndescription: x\n',
    );
    project.write('.yaao/skills/badph/prompt.md', 'use {{unknown}}');
    const r = await runCli(['--cwd', project.path, '--json', 'skills', 'validate']);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      reports: { name: string; ok: boolean; issues: { code: string }[] }[];
    };
    const bad = parsed.reports.find((r) => r.name === 'badph');
    expect(bad?.ok).toBe(false);
    expect(bad?.issues.some((i) => i.code === 'YAAO_SKILL_UNDECLARED_PLACEHOLDER')).toBe(true);
  });
});
