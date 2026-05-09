import { describe, it, expect } from 'vitest';
import { runCli } from '../../helpers/cli.js';

describe('global --cwd flag', () => {
  it('is accepted by the program parser', async () => {
    // init is a stub at F1.2 (filled in F1.4); we just verify --cwd doesn't crash
    // the parser. F1.4 adds a real --cwd assertion against scaffolded files.
    const r = await runCli(['--cwd', '/tmp', 'init']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('F1.4');
  });
});
