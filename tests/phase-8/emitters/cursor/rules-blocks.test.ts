import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitCursor } from '../../../../src/skills/emitters/cursor.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string, description = 'desc'): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description,
      appliesTo: { agents: ['cursor'], globs: [], dirs: [] },
      tools: [],
      inputs: [],
      trigger: { manual: true, matchPath: [] },
    },
    prompt: 'b',
    examples: [],
    origin: '/x',
  };
}

describe('Cursor rules file', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes the always-applied header + one block per skill', () => {
    project = createTmpProject();
    emitCursor([skill('yaao-planner'), skill('yaao-converter')], { cwd: project.path });
    const body = readFileSync(join(project.path, '.cursor', 'rules', 'yaao.mdc'), 'utf8');
    expect(body).toContain('alwaysApply: true');
    expect(body).toContain('yaao-managed: yaao-planner@1');
    expect(body).toContain('yaao-managed: yaao-converter@1');
  });

  it('a skill not applicable to cursor produces no block', () => {
    project = createTmpProject();
    const onlyClaude = skill('claude-only');
    onlyClaude.metadata.appliesTo.agents = ['claude-code'];
    const r = emitCursor([onlyClaude], { cwd: project.path });
    expect(r.files).toEqual([]);
  });
});
