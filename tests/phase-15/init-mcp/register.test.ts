import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerYaaoMcp } from '../../../src/init/mcp-register.js';

function freshWs(): string {
  return mkdtempSync(join(tmpdir(), 'yaao-mcp-reg-'));
}

describe('F15.2 — registerYaaoMcp', () => {
  it('creates .mcp.json with the yaao entry on a fresh repo', () => {
    const cwd = freshWs();
    const r = registerYaaoMcp({ cwd });
    expect(r.action).toBe('created');
    expect(existsSync(r.path)).toBe(true);
    const parsed = JSON.parse(readFileSync(r.path, 'utf8')) as {
      mcpServers: { yaao: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.yaao.command).toBe('yaao');
    expect(parsed.mcpServers.yaao.args).toEqual(['serve']);
  });

  it("preserves existing mcpServers entries when merging", () => {
    const cwd = freshWs();
    const path = join(cwd, '.mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          'user-server': { command: 'my-tool', args: ['--flag'] },
        },
      }),
    );
    const r = registerYaaoMcp({ cwd });
    expect(r.action).toBe('merged');
    const parsed = JSON.parse(readFileSync(r.path, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers['user-server']?.command).toBe('my-tool');
    expect(parsed.mcpServers.yaao?.command).toBe('yaao');
  });

  it("is a no-op when the existing yaao entry matches", () => {
    const cwd = freshWs();
    const path = join(cwd, '.mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { yaao: { command: 'yaao', args: ['serve'] } },
      }),
    );
    const before = readFileSync(path, 'utf8');
    const r = registerYaaoMcp({ cwd });
    expect(r.action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it("leaves a non-matching yaao entry untouched and returns a conflict warning", () => {
    const cwd = freshWs();
    const path = join(cwd, '.mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { yaao: { command: 'my-custom-yaao', args: ['--port', '8000'] } },
      }),
    );
    const r = registerYaaoMcp({ cwd });
    expect(r.action).toBe('conflict');
    expect(r.warning).toMatch(/--force/);
    const parsed = JSON.parse(readFileSync(r.path, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers.yaao?.command).toBe('my-custom-yaao');
  });

  it("--force overwrites a non-matching entry", () => {
    const cwd = freshWs();
    const path = join(cwd, '.mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { yaao: { command: 'my-custom-yaao' } },
      }),
    );
    const r = registerYaaoMcp({ cwd, force: true });
    expect(r.action).toBe('merged');
    const parsed = JSON.parse(readFileSync(r.path, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers.yaao?.command).toBe('yaao');
    expect(parsed.mcpServers.yaao?.args).toEqual(['serve']);
  });

  it('surfaces malformed JSON as a conflict warning rather than crashing', () => {
    const cwd = freshWs();
    const path = join(cwd, '.mcp.json');
    writeFileSync(path, '{not valid json');
    const r = registerYaaoMcp({ cwd });
    expect(r.action).toBe('conflict');
    expect(r.warning).toMatch(/not valid JSON/);
  });
});
