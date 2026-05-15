import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao skills install on a fresh project', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('emits Claude Code + Cursor artifacts when both agents are enabled', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    await runCli(['--cwd', project.path, 'init', '--minimal']);
    project.write(
      '.yaao/skills/team-style/skill.yaml',
      `name: team-style
version: 1
description: Team coding style guide
appliesTo:
  agents: [claude-code, cursor]
`,
    );
    project.write('.yaao/skills/team-style/prompt.md', 'follow the style');

    const r = await runCli(['--cwd', project.path, 'skills', 'install']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project.path, '.claude', 'yaao-mcp.json'))).toBe(true);
    expect(existsSync(join(project.path, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(project.path, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(project.path, '.cursor', 'rules', 'yaao.mdc'))).toBe(true);
  });
});
