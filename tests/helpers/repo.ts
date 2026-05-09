import { execaSync } from 'execa';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestRepo {
  path: string;
  write(rel: string, contents: string): void;
  commit(message: string): string;
  cleanup(): void;
  run(args: string[]): { stdout: string; exitCode: number };
}

const env: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'yaao test',
  GIT_AUTHOR_EMAIL: 'test@yaao.dev',
  GIT_COMMITTER_NAME: 'yaao test',
  GIT_COMMITTER_EMAIL: 'test@yaao.dev',
  GIT_TERMINAL_PROMPT: '0',
};

export function createTestRepo(): TestRepo {
  const path = mkdtempSync(join(tmpdir(), 'yaao-repo-'));
  execaSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env });
  // local git config so subsequent invocations (which may not inherit our env) succeed
  execaSync('git', ['config', 'user.name', 'yaao test'], { cwd: path });
  execaSync('git', ['config', 'user.email', 'test@yaao.dev'], { cwd: path });
  execaSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: path });
  // ensure there is at least one commit
  writeFileSync(join(path, '.gitkeep'), '');
  execaSync('git', ['add', '.gitkeep'], { cwd: path, env });
  execaSync('git', ['commit', '-q', '-m', 'init'], { cwd: path, env });

  const write = (rel: string, contents: string) => {
    const full = join(path, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  };
  const commit = (message: string): string => {
    execaSync('git', ['add', '-A'], { cwd: path, env });
    execaSync('git', ['commit', '-q', '-m', message], { cwd: path, env });
    return execaSync('git', ['rev-parse', 'HEAD'], { cwd: path, env }).stdout.trim();
  };
  const run = (args: string[]) => {
    const r = execaSync('git', args, { cwd: path, env, reject: false });
    return { stdout: r.stdout?.toString() ?? '', exitCode: r.exitCode ?? -1 };
  };
  const cleanup = () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  return { path, write, commit, cleanup, run };
}
