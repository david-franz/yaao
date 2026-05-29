import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorBackend } from '../../../src/agents/cursor.js';

/**
 * Integration test: CursorBackend.spawn() writes .cursor/mcp.json before
 * the child process starts and restores on completion. We replace the
 * `cursor-agent` binary with `node` so the test runs without the real CLI
 * installed; the assertion is on the filesystem state, not on what the
 * CLI does with the overlay.
 */
describe('F14.2 — CursorBackend.spawn writes per-spawn MCP overlay', () => {
  it('overlay is present during the spawn and cleaned up after', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-spawn-'));
    const backend = new CursorBackend({ bin: process.execPath });
    // The spawn's buildArgs would normally produce ['--print', '--model', X];
    // we override behavior by feeding a no-op via stdin to node. Since the
    // bin is overridden to process.execPath (node), the resulting argv is
    // `node --print` which exits 0 immediately (prints nothing) — good
    // enough to exercise spawn/restore.
    const proc = await backend.spawn({
      cwd,
      prompt: '',
      mcpServers: [{ name: 'yaao', command: 'yaao', args: ['serve'] }],
    });
    const overlayPath = join(cwd, '.cursor', 'mcp.json');
    // Overlay must exist while the child is running.
    expect(existsSync(overlayPath)).toBe(true);
    const body = JSON.parse(readFileSync(overlayPath, 'utf8'));
    expect(body.mcpServers.yaao.command).toBe('yaao');
    // Drain events to allow completion.
    for await (const _ev of proc.events) {
      void _ev;
    }
    await proc.completed.catch(() => undefined);
    // After completion, the overlay file should be cleaned up.
    expect(existsSync(overlayPath)).toBe(false);
  });

  it('does not touch .cursor/ when no mcpServers are provided', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-spawn-'));
    const backend = new CursorBackend({ bin: process.execPath });
    const proc = await backend.spawn({ cwd, prompt: '' });
    for await (const _ev of proc.events) {
      void _ev;
    }
    await proc.completed.catch(() => undefined);
    expect(existsSync(join(cwd, '.cursor'))).toBe(false);
  });

  it("preserves user's pre-existing .cursor/mcp.json across the spawn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-cursor-spawn-'));
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    const original = '{"mcpServers":{"user-server":{"command":"my-cmd"}}}\n';
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), original);
    const backend = new CursorBackend({ bin: process.execPath });
    const proc = await backend.spawn({
      cwd,
      prompt: '',
      mcpServers: [{ name: 'yaao', command: 'yaao', args: ['serve'] }],
    });
    for await (const _ev of proc.events) {
      void _ev;
    }
    await proc.completed.catch(() => undefined);
    // Original must be restored byte-for-byte.
    expect(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
  });
});
