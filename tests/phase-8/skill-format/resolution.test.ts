import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSkill, listSkillDirs } from '../../../src/skills/format.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('skill resolution', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  let builtin: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => {
    project?.cleanup();
    builtin?.cleanup();
  });

  it('project skill wins over built-in', () => {
    project = createTmpProject();
    builtin = createTmpProject();
    // built-in
    mkdirSync(join(builtin.path, 'shared'), { recursive: true });
    writeFileSync(join(builtin.path, 'shared', 'skill.yaml'), 'name: shared\nversion: 1\ndescription: builtin\n');
    writeFileSync(join(builtin.path, 'shared', 'prompt.md'), 'builtin body');
    // project override
    project.write('.yaao/skills/shared/skill.yaml', 'name: shared\nversion: 2\ndescription: project\n');
    project.write('.yaao/skills/shared/prompt.md', 'project body');

    const s = resolveSkill('shared', {
      cwd: project.path,
      skipUser: true,
      builtinDir: builtin.path,
    });
    expect(s?.metadata.description).toBe('project');
    expect(s?.prompt).toBe('project body');
  });

  it('listSkillDirs reports source labels', () => {
    project = createTmpProject();
    builtin = createTmpProject();
    mkdirSync(join(builtin.path, 'yaao-planner'), { recursive: true });
    writeFileSync(join(builtin.path, 'yaao-planner', 'skill.yaml'), 'name: yaao-planner\nversion: 1\ndescription: x\n');
    writeFileSync(join(builtin.path, 'yaao-planner', 'prompt.md'), 'p');
    project.write('.yaao/skills/team-style/skill.yaml', 'name: team-style\nversion: 1\ndescription: x\n');
    project.write('.yaao/skills/team-style/prompt.md', 'p');

    const rows = listSkillDirs({ cwd: project.path, skipUser: true, builtinDir: builtin.path });
    const team = rows.find((r) => r.name === 'team-style');
    const planner = rows.find((r) => r.name === 'yaao-planner');
    expect(team?.source).toBe('project');
    expect(planner?.source).toBe('builtin');
  });
});
