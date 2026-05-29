import { describe, it, expect, beforeEach } from 'vitest';
import { execaSync } from 'execa';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../src/git/git.js';

function freshRepo(initialBranch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yaao-detect-'));
  execaSync('git', ['init', '-b', initialBranch], { cwd: dir });
  execaSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execaSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execaSync('git', ['add', '-A'], { cwd: dir });
  execaSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('F14.9 — git.detectDefaultBranch', () => {
  let nonRepo: string;
  beforeEach(() => {
    nonRepo = mkdtempSync(join(tmpdir(), 'yaao-non-repo-'));
  });

  it('returns the remote default when origin/HEAD is set (master)', async () => {
    // Create a "remote" repo with master as the default, then a local clone.
    const remote = freshRepo('master');
    const local = mkdtempSync(join(tmpdir(), 'yaao-clone-'));
    execaSync('git', ['clone', remote, local], { cwd: tmpdir() });
    const branch = await git.detectDefaultBranch(local);
    expect(branch).toBe('master');
  });

  it('returns the remote default when origin/HEAD is set (main)', async () => {
    const remote = freshRepo('main');
    const local = mkdtempSync(join(tmpdir(), 'yaao-clone-'));
    execaSync('git', ['clone', remote, local], { cwd: tmpdir() });
    expect(await git.detectDefaultBranch(local)).toBe('main');
  });

  it("falls back to init.defaultBranch when no remote is configured", async () => {
    const repo = freshRepo('trunk');
    // No remote was added; symbolic-ref refs/remotes/origin/HEAD fails.
    // The repo itself was initialized with -b trunk so init.defaultBranch
    // for the repo-local config is unset. Set a local override and assert.
    execaSync('git', ['config', '--local', 'init.defaultBranch', 'develop'], { cwd: repo });
    expect(await git.detectDefaultBranch(repo)).toBe('develop');
  });

  it("falls back to 'main' when nothing else is available", async () => {
    // Non-repo directory. detectDefaultBranch must not throw.
    const branch = await git.detectDefaultBranch(nonRepo);
    expect(branch).toBe('main');
  });
});
