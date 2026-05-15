import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitCursor, mergeMcpJson } from '../../../../src/skills/emitters/cursor.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description: 'd',
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

describe('Cursor emitter: mcp.json preserves user entries', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('adds yaao without removing other user MCP servers', () => {
    project = createTmpProject();
    project.write(
      '.cursor/mcp.json',
      JSON.stringify(
        {
          mcpServers: {
            'house-style': { command: 'npx', args: ['-y', '@me/style-mcp'] },
          },
        },
        null,
        2,
      ),
    );
    emitCursor([skill('yaao-planner')], { cwd: project.path });
    const parsed = JSON.parse(readFileSync(join(project.path, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers['house-style']?.command).toBe('npx');
    expect(parsed.mcpServers['yaao']?.command).toBe('yaao');
  });

  it('mergeMcpJson is pure', () => {
    const out = mergeMcpJson('{"mcpServers":{"a":{"command":"x","args":[]}}}', {
      command: 'yaao',
      args: ['serve', '--stdio'],
    });
    const parsed = JSON.parse(out) as { mcpServers: Record<string, { command: string }> };
    expect(parsed.mcpServers['a']?.command).toBe('x');
    expect(parsed.mcpServers['yaao']?.command).toBe('yaao');
  });
});
