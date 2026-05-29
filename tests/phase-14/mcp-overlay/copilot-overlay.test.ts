import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCopilotOverlay } from '../../../src/agents/mcp-overlay.js';

describe('F14.2 — Copilot MCP overlay (.vscode/mcp.json)', () => {
  it("writes .vscode/mcp.json in the VS Code 'servers' shape", () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-copilot-'));
    const handle = writeCopilotOverlay({
      cwd,
      mcpServers: [{ name: 'yaao', command: 'yaao', args: ['serve'] }],
    });
    expect(handle).toBeDefined();
    const body = JSON.parse(readFileSync(handle!.path, 'utf8'));
    expect(body.servers.yaao.command).toBe('yaao');
    expect(body.servers.yaao.type).toBe('stdio');
    expect(body.servers.yaao.args).toEqual(['serve']);
  });

  it('returns undefined when no servers are provided', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-copilot-'));
    const handle = writeCopilotOverlay({ cwd, mcpServers: [] });
    expect(handle).toBeUndefined();
  });

  it("restore() puts back the user's original .vscode/mcp.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-copilot-'));
    mkdirSync(join(cwd, '.vscode'), { recursive: true });
    const original = '{"servers":{"user":{"command":"thing"}}}\n';
    writeFileSync(join(cwd, '.vscode', 'mcp.json'), original);
    const handle = writeCopilotOverlay({
      cwd,
      mcpServers: [{ name: 'yaao', command: 'yaao', args: ['serve'] }],
    });
    handle!.restore();
    expect(readFileSync(handle!.path, 'utf8')).toBe(original);
    expect(existsSync(`${handle!.path}.yaao-bak`)).toBe(false);
  });
});
