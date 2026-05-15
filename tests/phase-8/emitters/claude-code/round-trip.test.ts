import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitClaudeCode } from '../../../../src/skills/emitters/claude-code.js';
import type { LoadedSkill } from '../../../../src/skills/format.js';
import { createTmpProject } from '../../../helpers/tmp-dir.js';

function skill(name: string): LoadedSkill {
  return {
    metadata: {
      name,
      version: 1,
      description: 'd',
      appliesTo: { agents: ['claude-code', 'cursor', 'copilot', 'codex', 'api'], globs: [], dirs: [] },
      tools: [],
      inputs: [],
      trigger: { manual: true, matchPath: [] },
    },
    prompt: 'body',
    examples: [],
    origin: '/x',
  };
}

describe('Claude Code emitter: round-trip stability', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('emit-twice produces byte-identical CLAUDE.md', () => {
    project = createTmpProject();
    emitClaudeCode([skill('yaao-planner'), skill('yaao-converter')], { cwd: project.path });
    const claudePath = join(project.path, '.claude', 'CLAUDE.md');
    const first = readFileSync(claudePath, 'utf8');
    emitClaudeCode([skill('yaao-planner'), skill('yaao-converter')], { cwd: project.path });
    expect(readFileSync(claudePath, 'utf8')).toBe(first);
  });

  it('preserves user-authored content above managed blocks', () => {
    project = createTmpProject();
    const claudePath = join(project.path, '.claude', 'CLAUDE.md');
    project.write('.claude/CLAUDE.md', '# My project\n\nLong-form instructions.\n');
    emitClaudeCode([skill('yaao-planner')], { cwd: project.path });
    const body = readFileSync(claudePath, 'utf8');
    expect(body).toContain('Long-form instructions.');
    expect(body).toContain('yaao-managed: yaao-planner@1');
  });

  it('skips skills that exclude claude-code in appliesTo', () => {
    project = createTmpProject();
    const onlyCursor: LoadedSkill = skill('cursor-only');
    onlyCursor.metadata.appliesTo.agents = ['cursor'];
    emitClaudeCode([onlyCursor], { cwd: project.path });
    const claudePath = join(project.path, '.claude', 'CLAUDE.md');
    // CLAUDE.md exists but should not contain the skill block.
    const body = readFileSync(claudePath, 'utf8');
    expect(body).not.toContain('cursor-only');
  });

  it('a different version replaces the existing block in place', () => {
    project = createTmpProject();
    emitClaudeCode([skill('yaao-planner')], { cwd: project.path });
    const v2 = skill('yaao-planner');
    v2.metadata.version = 2;
    v2.metadata.description = 'v2 description';
    emitClaudeCode([v2], { cwd: project.path });
    const body = readFileSync(join(project.path, '.claude', 'CLAUDE.md'), 'utf8');
    expect(body).toContain('yaao-managed: yaao-planner@2');
    expect(body).not.toContain('yaao-managed: yaao-planner@1');
    expect(body).toContain('v2 description');
  });
});
