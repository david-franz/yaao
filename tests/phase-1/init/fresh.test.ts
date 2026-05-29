import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao init on a fresh empty dir', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('creates the expected scaffold', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n'); // pretend it's a git repo
    const r = await runCli(['--cwd', project.path, 'init']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(project.path, '.yaao', 'yaao.config.json'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'secrets.local.json'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'plans'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'exec'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'skills'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'worktrees'))).toBe(true);
    expect(existsSync(join(project.path, '.yaao', 'runs'))).toBe(true);
    // Neither directory carries a .gitkeep — both are gitignored, so a
    // placeholder file would either be ignored (noise) or force an
    // exception in .gitignore. Leaving them empty is fine; git just
    // doesn't track empty dirs.
    expect(existsSync(join(project.path, '.yaao', 'worktrees', '.gitkeep'))).toBe(false);
    expect(existsSync(join(project.path, '.yaao', 'runs', '.gitkeep'))).toBe(false);
    const gi = readFileSync(join(project.path, '.gitignore'), 'utf8');
    expect(gi).toContain('# >>> yaao');
    expect(gi).toContain('.yaao/secrets.local.json');
  });

  it('the written config validates against the schema', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, 'init']);
    expect(r.exitCode).toBe(0);
    const { ConfigSchema } = await import('../../../src/config/schema.js');
    const raw = JSON.parse(
      readFileSync(join(project.path, '.yaao', 'yaao.config.json'), 'utf8'),
    ) as unknown;
    expect(() => ConfigSchema.parse(raw)).not.toThrow();
  });
});
