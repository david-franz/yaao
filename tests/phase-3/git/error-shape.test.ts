import { describe, it, expect, afterEach } from 'vitest';
import { git } from '../../../src/git/git.js';
import { GitError } from '../../../src/log/errors.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('GitError shape', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('carries cmd, exitCode, stdout, stderr on failure', async () => {
    repo = createTestRepo();
    try {
      // delete a branch that doesn't exist
      await git.deleteBranch('does-not-exist', { force: true }, repo.path);
    } catch (e) {
      const err = e as GitError;
      expect(err).toBeInstanceOf(GitError);
      expect(err.cmd[0]).toBe('git');
      expect(err.exitCode).toBeGreaterThan(0);
      expect(err.stderr.length).toBeGreaterThan(0);
      return;
    }
    throw new Error('expected GitError');
  });
});
