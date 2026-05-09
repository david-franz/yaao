import { describe, it, expect, afterEach } from 'vitest';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('git.merge', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('clean merge returns ok=true with a merge commit sha', async () => {
    repo = createTestRepo();
    repo.write('a.txt', 'one\n');
    repo.commit('add a');
    repo.run(['checkout', '-q', '-b', 'feat']);
    repo.write('b.txt', 'two\n');
    repo.commit('add b');
    repo.run(['checkout', '-q', 'main']);
    const r = await git.merge('feat', { ff: false }, repo.path);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.mergeCommit?.length).toBeGreaterThan(0);
  });

  it('reports conflicts as data, not exceptions', async () => {
    repo = createTestRepo();
    repo.write('shared.txt', 'baseline\n');
    repo.commit('baseline');
    repo.run(['checkout', '-q', '-b', 'one']);
    repo.write('shared.txt', 'one wins\n');
    repo.commit('one wins');
    repo.run(['checkout', '-q', 'main']);
    repo.run(['checkout', '-q', '-b', 'two']);
    repo.write('shared.txt', 'two wins\n');
    repo.commit('two wins');
    const r = await git.merge('one', { ff: false }, repo.path);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContain('shared.txt');
    await git.mergeAbort(repo.path);
  });
});
