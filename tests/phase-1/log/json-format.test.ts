import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('--json log format', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('emits one JSON object per line, each parseable', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, '--json', 'init']);
    const lines = r.stderr.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { level: string; msg: string; time: string };
      expect(typeof parsed.level).toBe('string');
      expect(typeof parsed.msg).toBe('string');
      expect(typeof parsed.time).toBe('string');
    }
  });

  it('text format does not produce JSON-parseable lines', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await runCli(['--cwd', project.path, 'init']);
    const lines = r.stderr.trim().split('\n').filter(Boolean);
    let parseFailed = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        parseFailed++;
      }
    }
    expect(parseFailed).toBeGreaterThan(0);
  });
});
