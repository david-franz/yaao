import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execaSync } from 'execa';
import { join } from 'node:path';
import { yaaoPruneTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { openJournal } from '../../../src/git/journal.js';
import { WorktreeManager, hashKey, dependsHash } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';

async function seedRun(
  repoPath: string,
  runId: string,
  planSlug: string,
  opts: {
    tasks: { id: string; branch: string; mergeStatus?: 'merged' | 'merge-failed'; mergeInto?: string }[];
    status?: 'success' | 'failed' | 'cancelled';
    materializeBranches?: boolean;
    materializeWorktrees?: boolean;
  },
): Promise<void> {
  const journalDir = join(repoPath, '.yaao', 'runs');
  const journal = await openJournal(runId, { dir: journalDir });
  await journal.append({
    t: 'run:start',
    time: '2026-05-01T00:00:00Z',
    runId,
    planFile: join(repoPath, '.yaao', 'exec', `${planSlug}.yaml`),
    planHash: 'h',
    config: { baseBranch: 'main', maxParallel: 1 },
  });
  for (const t of opts.tasks) {
    await journal.append({
      t: 'task:running',
      time: '2026-05-01T00:00:01Z',
      taskId: t.id,
      agent: 'claude-code',
      worktree: '/tmp/wt',
      branch: t.branch,
      pid: 0,
    });
    await journal.append({
      t: 'task:completed',
      time: '2026-05-01T00:00:02Z',
      taskId: t.id,
      durationMs: 1,
      filesChanged: 0,
      commit: '',
    });
    if (t.mergeStatus === 'merged') {
      await journal.append({
        t: 'task:merged',
        time: '2026-05-01T00:00:03Z',
        taskId: t.id,
        into: t.mergeInto ?? 'main',
        mergeCommit: 'd'.repeat(40),
      });
    } else if (t.mergeStatus === 'merge-failed') {
      await journal.append({
        t: 'task:merge-failed',
        time: '2026-05-01T00:00:03Z',
        taskId: t.id,
        into: t.mergeInto ?? 'main',
        reason: 'conflict',
        conflicts: ['x'],
      });
    }
  }
  await journal.append({
    t: 'run:end',
    time: '2026-05-01T00:00:04Z',
    status: opts.status ?? 'success',
    durationMs: 100,
  });
  await journal.close();
  if (opts.materializeBranches) {
    for (const t of opts.tasks) {
      execaSync('git', ['branch', t.branch, 'main'], { cwd: repoPath });
    }
  }
  if (opts.materializeWorktrees) {
    const mgr = new WorktreeManager({ git, rootDir: repoPath, worktreeRoot: '.yaao/worktrees' });
    for (const t of opts.tasks) {
      await mgr.create({
        runId,
        taskId: t.id,
        branch: `${runId}/${t.id}`,
        baseBranch: 'main',
        parentBranches: [],
        rootDir: repoPath,
        worktreeRoot: '.yaao/worktrees',
        planName: planSlug,
        promptHash: hashKey(`prompt-${t.id}`),
        dependsHash: dependsHash([]),
      });
    }
  }
}

describe('yaao_prune MCP tool', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('dryRun defaults to true and never mutates', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    writeFileSync(join(repo.path, '.yaao', 'exec', 'p.yaml'), 'plan:\n  name: p\n  version: 1\ntasks: []\n');
    await seedRun(repo.path, 'r1', 'p', {
      tasks: [{ id: 't', branch: 'p/t', mergeStatus: 'merged' }],
      materializeBranches: true,
    });

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool({ target: 'run', runId: 'r1' }, ctx);
    expect(r.structuredContent['ok']).toBe(true);
    expect(r.structuredContent['dryRun']).toBe(true);
    const removed = r.structuredContent['removed'] as { branches: string[]; runDirs: string[] };
    expect(removed.branches).toContain('p/t');
    expect(removed.runDirs.length).toBe(1);

    // Nothing actually deleted.
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'r1'))).toBe(true);
    const branches = execaSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo.path }).stdout;
    expect(branches).toContain('p/t');
  });

  it('refuses to delete the configured base-branch', async () => {
    repo = createTestRepo();
    // Craft a (malformed) run that records `main` as a task branch.
    await seedRun(repo.path, 'r-bad', 'p', {
      tasks: [{ id: 't', branch: 'main', mergeStatus: 'merged' }],
    });
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool(
      { target: 'run', runId: 'r-bad', scope: ['branches'], dryRun: false, force: true },
      ctx,
    );
    const skipped = r.structuredContent['skipped'] as { path: string; reason: string }[];
    expect(skipped.find((s) => s.path === 'main')?.reason).toMatch(/is-base-branch/);
    const removed = r.structuredContent['removed'] as { branches: string[] };
    expect(removed.branches).not.toContain('main');
  });

  it('skips branches not merged into their target unless force is set', async () => {
    repo = createTestRepo();
    await seedRun(repo.path, 'r2', 'p', {
      tasks: [
        { id: 'a', branch: 'p/a', mergeStatus: 'merged' },
        { id: 'b', branch: 'p/b', mergeStatus: 'merge-failed' },
      ],
      materializeBranches: true,
    });
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool(
      { target: 'run', runId: 'r2', scope: ['branches'], dryRun: false },
      ctx,
    );
    const removed = r.structuredContent['removed'] as { branches: string[] };
    const skipped = r.structuredContent['skipped'] as { path: string; reason: string }[];
    expect(removed.branches).toEqual(['p/a']);
    expect(skipped.find((s) => s.path === 'p/b')?.reason).toBe('unmerged-commits');
  });

  it('target=all-failed prunes only failed/cancelled runs', async () => {
    repo = createTestRepo();
    await seedRun(repo.path, 'r-good', 'p', {
      tasks: [{ id: 't', branch: 'p/t', mergeStatus: 'merged' }],
      status: 'success',
      materializeBranches: true,
    });
    await seedRun(repo.path, 'r-bad', 'p', {
      tasks: [{ id: 't', branch: 'p/t2', mergeStatus: 'merged' }],
      status: 'failed',
      materializeBranches: true,
    });
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool({ target: 'all-failed', scope: ['runs'], dryRun: false }, ctx);
    const removed = r.structuredContent['removed'] as { runDirs: string[] };
    expect(removed.runDirs.some((p) => p.endsWith('/r-bad'))).toBe(true);
    expect(removed.runDirs.some((p) => p.endsWith('/r-good'))).toBe(false);
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'r-good'))).toBe(true);
    expect(existsSync(join(repo.path, '.yaao', 'runs', 'r-bad'))).toBe(false);
  });

  it('returns YAAO_PRUNE_NO_MATCH when no runs match the target', async () => {
    repo = createTestRepo();
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool({ target: 'run', runId: 'does-not-exist' }, ctx);
    expect(r.structuredContent['ok']).toBe(false);
    const errs = r.structuredContent['errors'] as { code: string }[];
    expect(errs[0]?.code).toBe('YAAO_PRUNE_NO_MATCH');
  });
});
