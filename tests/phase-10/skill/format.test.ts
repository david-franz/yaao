import { describe, it, expect } from 'vitest';
import { resolveSkill, validateSkill } from '../../../src/skills/format.js';
import { getBuiltinSkillsDir } from '../../../src/skills/builtin-dir.js';

describe('yaao-converter built-in skill', () => {
  it('resolves and validates', () => {
    const builtinDir = getBuiltinSkillsDir();
    expect(builtinDir).toBeDefined();
    if (!builtinDir) return;
    const skill = resolveSkill('yaao-converter', {
      cwd: '/tmp/builtin-converter',
      skipUser: true,
      builtinDir,
    });
    expect(skill).toBeDefined();
    if (!skill) return;
    expect(skill.metadata.name).toBe('yaao-converter');
    expect(skill.metadata.inputs.find((i) => i.name === 'input')?.required).toBe(true);
    expect(validateSkill(skill).ok).toBe(true);
  });
});
