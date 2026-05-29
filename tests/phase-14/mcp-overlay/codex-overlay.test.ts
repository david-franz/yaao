import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexOverlay } from '../../../src/agents/mcp-overlay.js';

describe('F14.2 — Codex MCP overlay (TOML)', () => {
  it('writes .yaao/codex-mcp-overlay.toml with [mcp_servers.<name>] sections', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-codex-'));
    const handle = writeCodexOverlay({
      cwd,
      mcpServers: [
        { name: 'yaao', command: 'yaao', args: ['serve'] },
        {
          name: 'ctx-sys',
          command: 'ctx-sys',
          args: ['serve', '--socket', '/tmp/x.sock'],
          env: { CTX_SYS_LOG: 'info' },
        },
      ],
    });
    expect(handle).toBeDefined();
    const body = readFileSync(handle!.path, 'utf8');
    expect(body).toContain('[mcp_servers.yaao]');
    expect(body).toContain('command = "yaao"');
    expect(body).toContain('args = ["serve"]');
    expect(body).toContain('[mcp_servers.ctx-sys]');
    expect(body).toContain('args = ["serve", "--socket", "/tmp/x.sock"]');
    expect(body).toContain('[mcp_servers.ctx-sys.env]');
    expect(body).toContain('CTX_SYS_LOG = "info"');
  });

  it('returns undefined when no servers are provided', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-codex-'));
    const handle = writeCodexOverlay({ cwd, mcpServers: [] });
    expect(handle).toBeUndefined();
  });

  it('restore() removes the overlay file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-codex-'));
    const handle = writeCodexOverlay({
      cwd,
      mcpServers: [{ name: 'x', command: 'echo' }],
    });
    expect(existsSync(handle!.path)).toBe(true);
    handle!.restore();
    expect(existsSync(handle!.path)).toBe(false);
  });

  it('escapes quotes and backslashes in string values', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-codex-'));
    const handle = writeCodexOverlay({
      cwd,
      mcpServers: [{ name: 'x', command: 'cmd "with quotes"', args: ['back\\slash'] }],
    });
    const body = readFileSync(handle!.path, 'utf8');
    expect(body).toContain('command = "cmd \\"with quotes\\""');
    expect(body).toContain('args = ["back\\\\slash"]');
  });
});
