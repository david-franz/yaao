import { describe, it, expect, afterEach } from 'vitest';
import { resolveSkill } from '../../../src/skills/format.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('skill parse', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('loads a minimal skill (name + description + prompt)', () => {
    project = createTmpProject();
    project.write(
      '.yaao/skills/minimal/skill.yaml',
      `name: minimal
version: 1
description: A minimal skill
`,
    );
    project.write('.yaao/skills/minimal/prompt.md', 'do the thing');
    const s = resolveSkill('minimal', { cwd: project.path, skipUser: true });
    expect(s).toBeDefined();
    expect(s?.metadata.name).toBe('minimal');
    expect(s?.metadata.version).toBe(1);
    expect(s?.prompt).toBe('do the thing');
    expect(s?.metadata.appliesTo.agents.length).toBeGreaterThan(0);
  });

  it('returns undefined for a missing skill', () => {
    project = createTmpProject();
    expect(resolveSkill('ghost', { cwd: project.path, skipUser: true })).toBeUndefined();
  });

  it('throws on a malformed skill.yaml', () => {
    const p = createTmpProject();
    project = p;
    p.write('.yaao/skills/bad/skill.yaml', 'name: Bad Slug\nversion: 1\ndescription: x\n');
    p.write('.yaao/skills/bad/prompt.md', 'x');
    expect(() => resolveSkill('bad', { cwd: p.path, skipUser: true })).toThrow();
  });
});
