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
    // Make `p/b` actually diverge from main with a unique commit — without
    // this, the ancestor-check would (correctly) classify it safe to delete
    // and skip the skip. The merge-failed scenario the test is about is
    // specifically the case where the branch *has* unique work that didn't
    // land; reflect that.
    execaSync('git', ['checkout', 'p/b'], { cwd: repo.path });
    writeFileSync(join(repo.path, 'b-work.txt'), 'unmerged work\n');
    execaSync('git', ['add', 'b-work.txt'], { cwd: repo.path });
    execaSync('git', ['commit', '-m', 'unmerged work on p/b'], { cwd: repo.path });
    execaSync('git', ['checkout', 'main'], { cwd: repo.path });

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

  it('removes worktrees before branches, even when the worktree belongs to a different run', async () => {
    repo = createTestRepo();
    // Run A leaves a stamped worktree behind that *holds* a branch later
    // re-used by run B's journal. The original prune indexed worktrees only
    // by their sourceRunId, so pruning run B couldn't see this worktree —
    // the branch delete then fired with the worktree still attached, and
    // `git branch -D` refused with "used by worktree".
    const sharedBranch = 'kheap/kernel-wireup';
    const mgr = new WorktreeManager({
      git,
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    const wt = await mgr.create({
      runId: 'run-A',
      taskId: 'kernel-wireup',
      branch: sharedBranch,
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
      planName: 'kheap',
      promptHash: hashKey('prompt-A'),
      dependsHash: dependsHash([]),
    });
    expect(existsSync(wt.path)).toBe(true);

    // Run B's journal records the same branch as run-B's `kernel-wireup`
    // task. The branch is technically owned by run-A's worktree on disk.
    await seedRun(repo.path, 'run-B', 'kheap', {
      tasks: [{ id: 'kernel-wireup', branch: sharedBranch, mergeStatus: 'merged' }],
    });

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool(
      { target: 'run', runId: 'run-B', scope: ['worktrees', 'branches', 'runs'], dryRun: false },
      ctx,
    );
    expect(r.structuredContent['ok']).toBe(true);
    const removed = r.structuredContent['removed'] as {
      worktrees: string[];
      branches: string[];
      runDirs: string[];
    };
    // Cross-run worktree (stamped by run-A but holding run-B's branch) is removed.
    expect(removed.worktrees).toContain(wt.path);
    // Branch is removed because the worktree no longer holds it.
    expect(removed.branches).toContain(sharedBranch);
    // No fall-through error from the branch step.
    expect(r.structuredContent['errors']).toEqual([]);
  });

  it('dry-run and actual-run agree on the same skip decisions for the same workspace', async () => {
    repo = createTestRepo();
    // Build a state with a worktree that has uncommitted changes — the
    // canonical "should be skipped" case.
    const mgr = new WorktreeManager({
      git,
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    const wt = await mgr.create({
      runId: 'run-dirty',
      taskId: 'dirty',
      branch: 'p/dirty',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
      planName: 'p',
      promptHash: hashKey('p'),
      dependsHash: dependsHash([]),
    });
    // Leave an uncommitted file in the worktree.
    writeFileSync(join(wt.path, 'wip.txt'), 'work in progress\n');

    await seedRun(repo.path, 'run-dirty', 'p', {
      tasks: [{ id: 'dirty', branch: 'p/dirty', mergeStatus: 'merged' }],
    });

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };

    const dry = await yaaoPruneTool(
      { target: 'run', runId: 'run-dirty', scope: ['worktrees'], dryRun: true },
      ctx,
    );
    const drySkipped = dry.structuredContent['skipped'] as { path: string; reason: string }[];
    const dryRemoved = dry.structuredContent['removed'] as { worktrees: string[] };
    expect(drySkipped.find((s) => s.path === wt.path)?.reason).toBe('uncommitted-changes');
    expect(dryRemoved.worktrees).not.toContain(wt.path);

    const actual = await yaaoPruneTool(
      { target: 'run', runId: 'run-dirty', scope: ['worktrees'], dryRun: false },
      ctx,
    );
    const actualSkipped = actual.structuredContent['skipped'] as { path: string; reason: string }[];
    const actualRemoved = actual.structuredContent['removed'] as { worktrees: string[] };
    // Same answer: skipped, not removed. The dry-run's promise that the
    // worktree would be skipped must be honored by the apply path.
    expect(actualSkipped.find((s) => s.path === wt.path)?.reason).toBe('uncommitted-changes');
    expect(actualRemoved.worktrees).not.toContain(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });

  it('force: true bypasses the never-merged guard and deletes the branch', async () => {
    // Reviewer's "force not honored for never-merged" report. Without force,
    // a branch with unique commits and no `mergeStatus: merged` record is
    // skipped. With force, it goes through.
    repo = createTestRepo();
    await seedRun(repo.path, 'r-nm', 'p', {
      // No mergeStatus → falls into the 'never-merged' branch of the
      // skip-reason ternary (status='completed' but no task:merged event).
      tasks: [{ id: 'a', branch: 'p/a' }],
      materializeBranches: true,
    });
    // Diverge `p/a` from main so the ancestor-aware safety check actually
    // has something to be careful about — without unique work, the new
    // check correctly classifies it as safe-to-delete without force.
    execaSync('git', ['checkout', 'p/a'], { cwd: repo.path });
    writeFileSync(join(repo.path, 'a-work.txt'), 'work in progress\n');
    execaSync('git', ['add', 'a-work.txt'], { cwd: repo.path });
    execaSync('git', ['commit', '-m', 'p/a work'], { cwd: repo.path });
    execaSync('git', ['checkout', 'main'], { cwd: repo.path });

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };

    // Without force: skipped with reason `never-merged`.
    const dry = await yaaoPruneTool(
      { target: 'run', runId: 'r-nm', scope: ['branches'], dryRun: true },
      ctx,
    );
    const drySkipped = dry.structuredContent['skipped'] as { path: string; reason: string }[];
    expect(drySkipped.find((s) => s.path === 'p/a')?.reason).toBe('never-merged');

    // With force: branch is in plannedBranches and gets deleted.
    const r = await yaaoPruneTool(
      { target: 'run', runId: 'r-nm', scope: ['branches'], dryRun: false, force: true },
      ctx,
    );
    expect(r.structuredContent['ok']).toBe(true);
    const removed = r.structuredContent['removed'] as { branches: string[] };
    expect(removed.branches).toContain('p/a');
    // git no longer has the branch.
    const branches = execaSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: repo.path,
    }).stdout;
    expect(branches).not.toContain('p/a');
  });

  it('a branch whose tip is already an ancestor of base is safe to delete without force', async () => {
    // Reviewer's edge case: a task failed before committing anything, so
    // its branch literally points at base's tip. There are no unique
    // commits to lose by deleting it; requiring `force: true` is friction
    // without safety benefit.
    repo = createTestRepo();
    await seedRun(repo.path, 'r-anc', 'p', {
      // No mergeStatus recorded — the journal-only signal would say
      // "never-merged" and skip. But git can see this is already an
      // ancestor of main.
      tasks: [{ id: 'a', branch: 'p/a' }],
      materializeBranches: true,
    });
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoPruneTool(
      { target: 'run', runId: 'r-anc', scope: ['branches'], dryRun: false },
      ctx,
    );
    const removed = r.structuredContent['removed'] as { branches: string[] };
    const skipped = r.structuredContent['skipped'] as { path: string; reason: string }[];
    expect(removed.branches).toContain('p/a');
    expect(skipped.find((s) => s.path === 'p/a')).toBeUndefined();
  });

  it('keeps the run dir when any in-scope artifact for the run was skipped', async () => {
    // Reviewer's "orphaned-branch reachability" — previously the run dir
    // got deleted in the same pass that skipped a branch, leaving the
    // skipped branch unreachable via `target: run` for follow-up cleanup.
    // Now: when an artifact is skipped, the run dir survives so a
    // follow-up `force: true` call can still find the run.
    repo = createTestRepo();
    await seedRun(repo.path, 'r-orphan', 'p', {
      tasks: [{ id: 'a', branch: 'p/a' }],
      materializeBranches: true,
    });
    // Diverge p/a so the ancestor check doesn't autopass it.
    execaSync('git', ['checkout', 'p/a'], { cwd: repo.path });
    writeFileSync(join(repo.path, 'a.txt'), 'work\n');
    execaSync('git', ['add', 'a.txt'], { cwd: repo.path });
    execaSync('git', ['commit', '-m', 'unmerged'], { cwd: repo.path });
    execaSync('git', ['checkout', 'main'], { cwd: repo.path });

    const journalDir = join(repo.path, '.yaao', 'runs', 'r-orphan');
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };

    // First call (no force): branch is skipped, run dir must be preserved.
    const r1 = await yaaoPruneTool(
      {
        target: 'run',
        runId: 'r-orphan',
        scope: ['worktrees', 'branches', 'runs'],
        dryRun: false,
      },
      ctx,
    );
    const skipped1 = r1.structuredContent['skipped'] as { kind: string; path: string; reason: string }[];
    expect(skipped1.find((s) => s.path === 'p/a' && s.kind === 'branch')).toBeDefined();
    expect(skipped1.find((s) => s.kind === 'runDir')?.reason).toMatch(/run-has-skipped-artifacts/);
    expect(existsSync(journalDir)).toBe(true);

    // Follow-up with force: branch and run dir both go.
    const r2 = await yaaoPruneTool(
      {
        target: 'run',
        runId: 'r-orphan',
        scope: ['worktrees', 'branches', 'runs'],
        dryRun: false,
        force: true,
      },
      ctx,
    );
    const removed2 = r2.structuredContent['removed'] as { branches: string[]; runDirs: string[] };
    expect(removed2.branches).toContain('p/a');
    expect(removed2.runDirs.some((p) => p.endsWith('/r-orphan'))).toBe(true);
    expect(existsSync(journalDir)).toBe(false);
  });

  it('reaps the empty per-run worktree parent dir after the last child is removed', async () => {
    repo = createTestRepo();
    await seedRun(repo.path, 'run-reap', 'p', {
      tasks: [
        { id: 'a', branch: 'p/a', mergeStatus: 'merged' },
        { id: 'b', branch: 'p/b', mergeStatus: 'merged' },
      ],
      materializeBranches: true,
      materializeWorktrees: true,
    });
    const runParent = join(repo.path, '.yaao', 'worktrees', 'run-reap');
    expect(existsSync(runParent)).toBe(true);

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    await yaaoPruneTool(
      { target: 'run', runId: 'run-reap', scope: ['worktrees'], dryRun: false },
      ctx,
    );

    // Per-task subdirs are gone AND the (now-empty) per-run parent is rmdir'd
    // too. Previously each prune left a `.yaao/worktrees/run-*/` skeleton
    // behind that the user had to clean up by hand.
    expect(existsSync(join(runParent, 'a'))).toBe(false);
    expect(existsSync(join(runParent, 'b'))).toBe(false);
    expect(existsSync(runParent)).toBe(false);
    // The shared `.yaao/worktrees/` root is preserved.
    expect(existsSync(join(repo.path, '.yaao', 'worktrees'))).toBe(true);
  });
});
