import { describe, it, expect, afterEach } from 'vitest';
import { resolveSkill, validateSkill } from '../../../src/skills/format.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('skill validation', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reports unreferenced inputs and undeclared placeholders', () => {
    project = createTmpProject();
    project.write(
      '.yaao/skills/x/skill.yaml',
      `name: x
version: 1
description: X
inputs:
  - name: foo
    required: true
`,
    );
    // prompt references {{bar}} (undeclared) and never references {{foo}} (unreferenced).
    project.write('.yaao/skills/x/prompt.md', 'do {{bar}} now');
    const s = resolveSkill('x', { cwd: project.path, skipUser: true });
    expect(s).toBeDefined();
    if (!s) return;
    const v = validateSkill(s);
    expect(v.ok).toBe(false);
    const codes = v.issues.map((i) => i.code);
    expect(codes).toContain('YAAO_SKILL_UNREFERENCED_INPUT');
    expect(codes).toContain('YAAO_SKILL_UNDECLARED_PLACEHOLDER');
  });

  it('passes when all inputs are referenced and no stray placeholders exist', () => {
    project = createTmpProject();
    project.write(
      '.yaao/skills/y/skill.yaml',
      `name: y
version: 1
description: Y
inputs:
  - name: foo
`,
    );
    project.write('.yaao/skills/y/prompt.md', 'do {{foo}}');
    const s = resolveSkill('y', { cwd: project.path, skipUser: true });
    expect(s).toBeDefined();
    if (!s) return;
    expect(validateSkill(s).ok).toBe(true);
  });

  it('flags a prompt larger than 10 KB unless allowLarge', () => {
    project = createTmpProject();
    project.write(
      '.yaao/skills/big/skill.yaml',
      `name: big
version: 1
description: B
`,
    );
    project.write('.yaao/skills/big/prompt.md', 'x'.repeat(11_000));
    const s = resolveSkill('big', { cwd: project.path, skipUser: true });
    if (!s) throw new Error('skill missing');
    expect(validateSkill(s).ok).toBe(false);
    expect(validateSkill(s, { allowLarge: true }).ok).toBe(true);
  });
});
