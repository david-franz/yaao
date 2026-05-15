import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitCodex, renderTomlOverlay } from '../../../../src/skills/emitters/codex.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description: 'd',
      appliesTo: { agents: ['codex'], globs: [], dirs: [] },
      tools: [],
      inputs: [],
      trigger: { manual: true, matchPath: [] },
    },
    prompt: 'b',
    examples: [],
    origin: '/x',
  };
}

describe('Codex emitter', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes the TOML overlay and AGENTS.md managed block', () => {
    project = createTmpProject();
    emitCodex([skill('yaao-planner')], { cwd: project.path });
    const overlay = readFileSync(
      join(project.path, '.yaao', 'codex-mcp-overlay.toml'),
      'utf8',
    );
    expect(overlay).toContain('[mcp_servers.yaao]');
    expect(overlay).toContain('command = "yaao"');
    const agents = readFileSync(join(project.path, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('yaao-managed: yaao-planner@1');
  });

  it('renderTomlOverlay is stable', () => {
    expect(renderTomlOverlay()).toBe(renderTomlOverlay());
  });
});
