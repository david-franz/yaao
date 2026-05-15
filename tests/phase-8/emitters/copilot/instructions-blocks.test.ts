import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitCopilot, mergeCopilotMcp } from '../../../../src/skills/emitters/copilot.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description: 'd',
      appliesTo: { agents: ['copilot'], globs: [], dirs: [] },
      tools: [],
      inputs: [],
      trigger: { manual: true, matchPath: [] },
    },
    prompt: 'b',
    examples: [],
    origin: '/x',
  };
}

describe('Copilot emitter', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes copilot-instructions.md with managed blocks', () => {
    project = createTmpProject();
    emitCopilot([skill('yaao-planner')], { cwd: project.path });
    const body = readFileSync(
      join(project.path, '.github', 'copilot-instructions.md'),
      'utf8',
    );
    expect(body).toContain('yaao-managed: yaao-planner@1');
  });

  it('mergeCopilotMcp uses `servers:` and preserves user entries', () => {
    const out = mergeCopilotMcp('{"servers":{"a":{"type":"stdio","command":"x","args":[]}}}', {
      type: 'stdio',
      command: 'yaao',
      args: ['serve', '--stdio'],
    });
    const parsed = JSON.parse(out) as { servers: Record<string, { type: string; command: string }> };
    expect(parsed.servers['a']?.command).toBe('x');
    expect(parsed.servers['yaao']?.command).toBe('yaao');
  });

  it('respects mcpConfigPath override', () => {
    project = createTmpProject();
    emitCopilot([skill('yaao-planner')], {
      cwd: project.path,
      mcpConfigPath: '.github/copilot-mcp.json',
    });
    const body = readFileSync(join(project.path, '.github', 'copilot-mcp.json'), 'utf8');
    expect(body).toContain('yaao');
  });
});
