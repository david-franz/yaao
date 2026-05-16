import { describe, it, expect } from 'vitest';
import { yaaoSkillTool, discoverSkills, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('F12.5 skill-as-MCP-tool', () => {
  it('built-in yaao-planner skill is discoverable', () => {
    const ctx: ToolContext = { cwd: '/tmp/yaao-mcp-test', config: DEFAULT_CONFIG };
    const skills = discoverSkills(ctx);
    expect(skills.find((s) => s.name === 'yaao-planner')).toBeDefined();
    expect(skills.find((s) => s.name === 'yaao-converter')).toBeDefined();
  });

  it('yaaoSkillTool substitutes placeholders into the prompt body', () => {
    const ctx: ToolContext = { cwd: '/tmp/yaao-mcp-test', config: DEFAULT_CONFIG };
    const r = yaaoSkillTool('yaao-planner', { description: 'Build OAuth' }, ctx);
    expect(r.text).toContain('Build OAuth');
    const meta = r.structuredContent;
    expect(meta['skill']).toBe('yaao-planner');
    expect((meta['inputs'] as { description: string }).description).toBe('Build OAuth');
  });

  it('throws when a skill is missing', () => {
    const ctx: ToolContext = { cwd: '/tmp/yaao-mcp-test', config: DEFAULT_CONFIG };
    expect(() => yaaoSkillTool('does-not-exist', {}, ctx)).toThrow(/skill not found/);
  });
});
