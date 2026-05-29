import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCursorOverlay } from '../../../src/agents/mcp-overlay.js';

describe('F14.2 — Cursor MCP overlay', () => {
  it('writes .cursor/mcp.json with the supplied servers', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-'));
    const handle = writeCursorOverlay({
      cwd,
      mcpServers: [
        { name: 'yaao', command: 'yaao', args: ['serve'] },
        { name: 'ctx-sys', command: 'ctx-sys', args: ['serve', '--socket', '/tmp/x.sock'] },
      ],
    });
    expect(handle).toBeDefined();
    const body = JSON.parse(readFileSync(handle!.path, 'utf8'));
    expect(body.mcpServers.yaao.command).toBe('yaao');
    expect(body.mcpServers.yaao.args).toEqual(['serve']);
    expect(body.mcpServers['ctx-sys'].args).toEqual(['serve', '--socket', '/tmp/x.sock']);
  });

  it('returns undefined when no servers are provided', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-'));
    const handle = writeCursorOverlay({ cwd, mcpServers: [] });
    expect(handle).toBeUndefined();
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('restore() removes the overlay file when nothing existed before', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-'));
    const handle = writeCursorOverlay({
      cwd,
      mcpServers: [{ name: 'x', command: 'echo' }],
    });
    expect(existsSync(handle!.path)).toBe(true);
    handle!.restore();
    expect(existsSync(handle!.path)).toBe(false);
  });

  it("restore() puts back the user's original .cursor/mcp.json byte-for-byte", () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-'));
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = '{"mcpServers":{"user-server":{"command":"my-cmd"}}}\n';
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), original);
    const handle = writeCursorOverlay({
      cwd,
      mcpServers: [{ name: 'yaao', command: 'yaao', args: ['serve'] }],
    });
    // While overlay is in place, the file is yaao's
    const overlay = JSON.parse(readFileSync(handle!.path, 'utf8'));
    expect(overlay.mcpServers.yaao).toBeDefined();
    expect(overlay.mcpServers['user-server']).toBeUndefined();
    handle!.restore();
    expect(readFileSync(handle!.path, 'utf8')).toBe(original);
    expect(existsSync(`${handle!.path}.yaao-bak`)).toBe(false);
  });

  it('restore() is idempotent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-'));
    const handle = writeCursorOverlay({
      cwd,
      mcpServers: [{ name: 'x', command: 'echo' }],
    });
    handle!.restore();
    expect(() => handle!.restore()).not.toThrow();
  });
});
