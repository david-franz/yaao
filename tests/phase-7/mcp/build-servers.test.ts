import { describe, it, expect } from 'vitest';
import { buildMcpServers } from '../../../src/ctx-sys/mcp-config.js';
import { YaaoError } from '../../../src/log/errors.js';
import type { CtxSysHandle } from '../../../src/ctx-sys/spawn.js';

describe('buildMcpServers', () => {
  it('starts with yaao, then ctx-sys, then user servers sorted by name', () => {
    const ctxSys: CtxSysHandle = {
      socketPath: '/tmp/ctx.sock',
      pid: 1,
      ownsProcess: true,
      spawned: true,
      shutdown: async () => undefined,
    };
    const out = buildMcpServers({
      yaaoServer: { name: 'yaao', command: 'yaao', args: ['serve'], env: {} },
      ctxSys,
      userServers: {
        'design-tokens': { command: 'design-tokens-mcp' },
        'house-style': { command: 'npx', args: ['-y', '@me/style-mcp'] },
      },
    });
    expect(out.map((s) => s.name)).toEqual(['yaao', 'ctx-sys', 'design-tokens', 'house-style']);
    expect(out[1]?.args).toContain('--socket');
    expect(out[1]?.args).toContain('/tmp/ctx.sock');
  });

  it('omits ctx-sys when no handle is present', () => {
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
