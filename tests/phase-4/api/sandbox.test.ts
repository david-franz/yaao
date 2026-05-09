import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolSandbox } from '../../../src/agents/api/sandbox.js';
import { ApiToolError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('ToolSandbox', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('rejects absolute paths', () => {
    project = createTmpProject();
    const s = new ToolSandbox({ cwd: project.path });
    expect(() => s.readFile('/etc/passwd')).toThrow(ApiToolError);
  });

  it('rejects ../ traversal', () => {
    project = createTmpProject();
    const s = new ToolSandbox({ cwd: project.path });
    expect(() => s.readFile('../outside.txt')).toThrow(ApiToolError);
  });

  it('write_file + read_file round-trips', () => {
    project = createTmpProject();
    const s = new ToolSandbox({ cwd: project.path });
    s.writeFile('a.ts', 'export const x = 1;\n');
    expect(s.readFile('a.ts')).toBe('export const x = 1;\n');
  });

  it('list_files filters by glob', () => {
    project = createTmpProject();
    project.write('a.ts', '1');
    project.write('b.ts', '2');
    project.write('c.md', '3');
    const s = new ToolSandbox({ cwd: project.path });
    const ts = s.listFiles('*.ts').sort();
    expect(ts).toEqual(['a.ts', 'b.ts']);
  });

  it('apply_patch applies a unified diff', async () => {
    project = createTmpProject();
    project.write('a.txt', 'one\ntwo\n');
    // Make it a git repo so `git apply` has something to work against
    const { execaSync } = await import('execa');
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execaSync('git', ['init', '-q', '-b', 'main'], { cwd: project.path, env });
    execaSync('git', ['add', '.'], { cwd: project.path, env });
    execaSync('git', ['commit', '-q', '-m', 'init'], { cwd: project.path, env });

    const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-one
+ONE
 two
`;
    const s = new ToolSandbox({ cwd: project.path });
    const r = s.applyPatch(diff);
    expect(r.filesChanged).toBeGreaterThan(0);
    expect(readFileSync(join(project.path, 'a.txt'), 'utf8')).toBe('ONE\ntwo\n');
  });

  it('run_shell executes commands inside the worktree', () => {
    project = createTmpProject();
    writeFileSync(join(project.path, 'marker.txt'), 'present');
    const s = new ToolSandbox({ cwd: project.path });
    const r = s.runShell('ls marker.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('marker.txt');
    expect(existsSync(join(project.path, 'marker.txt'))).toBe(true);
  });
});
