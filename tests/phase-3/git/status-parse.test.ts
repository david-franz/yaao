import { describe, it, expect } from 'vitest';
import { parseStatus, parseWorktreeList } from '../../../src/git/git.js';

describe('parseStatus (porcelain v2)', () => {
  it('parses branch + ahead/behind', () => {
    const out = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 abc def file.ts
? new.txt
`;
    const s = parseStatus(out);
    expect(s.branch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.files[0]?.path).toBe('file.ts');
    expect(s.untracked).toEqual(['new.txt']);
  });

  it('parses renames into both files and renamed lists', () => {
    const out = `# branch.head main
2 R. N... 100644 100644 100644 abc def R100 new/path.ts\told/path.ts
`;
    const s = parseStatus(out);
    expect(s.renamed[0]?.path).toBe('new/path.ts');
    expect(s.renamed[0]?.origPath).toBe('old/path.ts');
    expect(s.files).toHaveLength(1);
  });
});

describe('parseWorktreeList', () => {
  it('parses multiple worktree records', () => {
    const out = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.yaao/worktrees/api
HEAD def456
branch refs/heads/oauth/api
`;
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(2);
    expect(list[0]?.branch).toBe('main');
    expect(list[1]?.branch).toBe('oauth/api');
  });
});
