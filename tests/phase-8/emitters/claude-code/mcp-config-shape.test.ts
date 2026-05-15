import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitClaudeCode } from '../../../../src/skills/emitters/claude-code.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string, description = 'desc'): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description,
      appliesTo: { agents: ['claude-code', 'cursor', 'copilot', 'codex', 'api'], globs: [], dirs: [] },
      tools: [],
      inputs: [{ name: 'description', required: true }],
      trigger: { manual: true, matchPath: [] },
    },
    prompt: 'body',
    examples: [],
    origin: '/x',
  };
}

describe('Claude Code emitter: yaao-mcp.json shape', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes the expected mcp.json with the yaao server entry', () => {
    project = createTmpProject();
    emitClaudeCode([skill('yaao-planner')], { cwd: project.path });
    const raw = readFileSync(join(project.path, '.claude', 'yaao-mcp.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers: { yaao: { command: string; args: string[] } } };
    expect(parsed.mcpServers.yaao.command).toBe('yaao');
    expect(parsed.mcpServers.yaao.args).toContain('serve');
    expect(parsed.mcpServers.yaao.args).toContain('--stdio');
  });
});
