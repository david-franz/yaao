import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeMcpConfig } from '../../../src/agents/claude-code.js';

describe('writeMcpConfig', () => {
  it('returns undefined for empty server list', () => {
    expect(writeMcpConfig(undefined)).toBeUndefined();
    expect(writeMcpConfig([])).toBeUndefined();
  });

  it('writes a valid mcp.json under a tmp dir', () => {
    const path = writeMcpConfig([
      { name: 'ctx-sys', command: 'ctx-sys', args: ['serve', '--socket', '/tmp/ctx.sock'] },
    ]);
    expect(path).toBeDefined();
    if (!path) return;
    try {
      expect(existsSync(path)).toBe(true);
      const json = JSON.parse(readFileSync(path, 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(json.mcpServers['ctx-sys']?.command).toBe('ctx-sys');
      expect(json.mcpServers['ctx-sys']?.args).toContain('--socket');
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});
