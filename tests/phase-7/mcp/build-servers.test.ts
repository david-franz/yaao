import { describe, it, expect } from 'vitest';
import { buildMcpServers } from '../../../src/ctx-sys/mcp-config.js';
import { YaaoError } from '../../../src/log/errors.js';

describe('buildMcpServers', () => {
  it('starts with yaao, then ctx-sys, then user servers sorted by name', () => {
    const out = buildMcpServers({
      yaaoServer: { name: 'yaao', command: 'yaao', args: ['serve'], env: {} },
      ctxSysProjectRoot: '/repo',
      userServers: {
        'design-tokens': { command: 'design-tokens-mcp' },
        'house-style': { command: 'npx', args: ['-y', '@me/style-mcp'] },
      },
    });
    expect(out.map((s) => s.name)).toEqual(['yaao', 'ctx-sys', 'design-tokens', 'house-style']);
    // Each agent spawns its own stdio `ctx-sys serve` pinned to the project root.
    expect(out[1]?.args).toEqual(['serve', '--project', '/repo']);
  });

  it('omits ctx-sys when no project root is present', () => {
    const out = buildMcpServers({ userServers: {} });
    expect(out).toEqual([]);
  });

  it('rejects reserved names for user servers', () => {
    expect(() =>
      buildMcpServers({
        userServers: { 'ctx-sys': { command: 'fake' } },
      }),
    ).toThrow(YaaoError);
  });
});
