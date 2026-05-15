import { describe, it, expect } from 'vitest';
import { resolveSkill, validateSkill } from '../../../src/skills/format.js';
import { getBuiltinSkillsDir } from '../../../src/skills/builtin-dir.js';

describe('yaao-planner built-in skill', () => {
  it('resolves and passes validation', () => {
    const builtinDir = getBuiltinSkillsDir();
    expect(builtinDir).toBeDefined();
    if (!builtinDir) return;
    const skill = resolveSkill('yaao-planner', {
      cwd: '/tmp/yaao-builtin-resolve',
      skipUser: true,
      builtinDir,
    });
    expect(skill).toBeDefined();
    if (!skill) return;
    expect(skill.metadata.name).toBe('yaao-planner');
    expect(skill.metadata.inputs.find((i) => i.name === 'description')?.required).toBe(true);
    const v = validateSkill(skill);
    expect(v.ok).toBe(true);
  });
});
