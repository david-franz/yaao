import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Git } from './git.js';
import { WorktreeError, WorktreeMergeError } from '../log/errors.js';

/**
 * Key that uniquely identifies a worktree's contract: which plan, which task,
 * which exact prompt text, and which set of dependency tasks. yaao reuses
 * worktrees across runs (resume, retry) — but ONLY when every field of the key
 * matches. A stale stamp with a mismatched key is treated as "no match" and
 * the lifecycle creates a fresh worktree.
 *
 * Previously yaao reused worktrees by taskId alone, which produced cross-plan
 * collisions whenever two plans happened to share a task id ("kernel-wireup"
 * in `timer-pit` and `kheap`). The agent would be dropped into the wrong
 * branch with the wrong files. See worktree-manager-cache-key.test.ts.
 */
export interface WorktreeStampKey {
  planName: string;
  taskId: string;
  /** sha256 of the resolved task prompt body, hex, first 16 chars. */
  promptHash: string;
  /** sha256 of the canonicalised `depends` list, hex, first 16 chars. */
  dependsHash: string;
}

export interface WorktreeRequest {
  runId: string;
  taskId: string;
  branch: string;
  baseBranch: string;
  parentBranches: string[];
  rootDir: string;
  worktreeRoot: string;
  /**
   * Composite cache-key fields written into the stamp for reuse-check.
   * Optional only for backward compatibility with tests that construct
   * synthetic requests; production code (lifecycle) always passes all three.
   * A stamp written without these is treated as legacy and never reused.
   */
  planName?: string;
  promptHash?: string;
  dependsHash?: string;
  /**
   * How to handle a conflict produced while merging a parent dep branch.
   *
   * - `abort` (default): aborts the merge, tears down the half-created
   *   worktree, and throws `WorktreeMergeError`. Matches the historical
   *   behaviour — the task fails before the agent ever sees the worktree.
   * - `leave-for-agent`: leaves the conflict markers in place and returns the
   *   worktree with `unresolvedConflicts` populated. The lifecycle prepends a
   *   conflict-resolution preamble to the agent prompt so the agent resolves
   *   the merge as part of its task. Subsequent parents are NOT merged after
   *   the first conflict — the agent finishes the current merge first.
   */
  onConflict?: 'abort' | 'leave-for-agent';
}

export interface Worktree {
  taskId: string;
  branch: string;
  path: string;
  baseCommit: string;
  /**
   * Run that originally stamped this worktree. When a later run reuses it
   * (resume, or sibling re-execution) this is the original runId — non-equal
   * to the active run means callers should surface a `cached: true` signal.
   */
  sourceRunId?: string;
  /** Files with conflict markers left in place by `onConflict: leave-for-agent`. */
  unresolvedConflicts?: string[];
  /** The parent branch whose merge produced the conflicts above. */
  conflictingParent?: string;
  /** Parents that weren't merged because we stopped at the first conflict. */
  deferredParents?: string[];
}

export interface WorktreeStamp {
  runId: string;
  taskId: string;
  baseCommit: string;
  branch: string;
  /**
   * Composite key fields. Older stamps written before the key was introduced
   * lack these — they are treated as legacy and never matched on reuse.
   */
  planName?: string;
  promptHash?: string;
  dependsHash?: string;
}

/**
 * Stable hash of a string, 16-char hex. Used to fingerprint prompt bodies and
 * dependency lists for the worktree cache key. The cache compares fingerprints,
 * not full text, to keep stamps compact.
 */
export function hashKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Canonicalise a depends list (sort, then join) before hashing so a reordering
 * of `depends: [a, b]` to `depends: [b, a]` doesn't invalidate the cache.
 */
export function dependsHash(depends: readonly string[]): string {
  return hashKey([...depends].sort().join('|'));
}

export interface WorktreeManagerOptions {
  git: Git;
  rootDir: string;
  worktreeRoot: string;
}

export class WorktreeManager {
  private readonly git: Git;
  private readonly rootDir: string;
  private readonly worktreeRoot: string;
  private readonly known = new Map<string, Worktree>();

  constructor(opts: WorktreeManagerOptions) {
    this.git = opts.git;
    this.rootDir = opts.rootDir;
    this.worktreeRoot = opts.worktreeRoot;
  }

  async create(req: WorktreeRequest): Promise<Worktree> {
    if (!(await this.git.isRepo(req.rootDir))) {
      throw new WorktreeError({ message: `not a git repo: ${req.rootDir}` });
    }
    const baseCommit = await this.git.revParse(req.baseBranch, req.rootDir);
    const path = resolve(req.rootDir, req.worktreeRoot, req.runId, req.taskId);
    if (existsSync(path)) {
      throw new WorktreeError({
        message: `worktree path already exists: ${path} — leftover from a prior run? Try \`yaao clean <run-id>\` or re-run with \`--force\``,
        path,
      });
    }
    if (await this.git.branchExists(req.branch, req.rootDir)) {
      throw new WorktreeError({
        message: `branch already exists: ${req.branch} — leftover from a prior run? Try \`yaao clean <run-id>\` or re-run with \`--force\``,
      });
    }
    mkdirSync(join(path, '..'), { recursive: true });
    await this.git.createBranch(req.branch, req.baseBranch, req.rootDir);
    await this.git.worktreeAdd(path, req.branch, req.rootDir);

    // Merge any additional parents in order. On conflict, behaviour is
    // governed by `req.onConflict` (default abort).
    let unresolvedConflicts: string[] | undefined;
    let conflictingParent: string | undefined;
    let deferredParents: string[] | undefined;
    for (let i = 0; i < req.parentBranches.length; i++) {
      const parent = req.parentBranches[i];
      if (parent === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- parents merge sequentially
      const result = await this.git.merge(parent, { ff: false }, path);
      if (result.ok) continue;
      if (req.onConflict === 'leave-for-agent') {
        unresolvedConflicts = result.conflicts;
        conflictingParent = parent;
        deferredParents = req.parentBranches.slice(i + 1);
        break;
      }
      // Default: abort + tear down so we don't leave half-merged state.
      try {
        await this.git.mergeAbort(path);
      } catch {
        // ignore — we're already failing
      }
      try {
        await this.git.worktreeRemove(path, { force: true }, req.rootDir);
      } catch {
        // ignore
      }
      try {
        await this.git.deleteBranch(req.branch, { force: true }, req.rootDir);
      } catch {
        // ignore
      }
      throw new WorktreeMergeError({
        message: `merge of '${parent}' into '${req.branch}' produced conflicts: ${result.conflicts.join(', ')}`,
        conflicts: result.conflicts,
        path,
      });
    }

    // Stamp the worktree so we can identify orphans later AND so cross-run
    // reuse can verify the worktree's contract matches the current task.
    const yaaoDir = join(path, '.yaao');
    mkdirSync(yaaoDir, { recursive: true });
    const stamp: WorktreeStamp = {
      runId: req.runId,
      taskId: req.taskId,
      branch: req.branch,
      baseCommit,
      ...(req.planName !== undefined ? { planName: req.planName } : {}),
      ...(req.promptHash !== undefined ? { promptHash: req.promptHash } : {}),
      ...(req.dependsHash !== undefined ? { dependsHash: req.dependsHash } : {}),
    };
    writeFileSync(join(yaaoDir, '.task'), JSON.stringify(stamp, null, 2));

    const wt: Worktree = {
      taskId: req.taskId,
      branch: req.branch,
      path,
      baseCommit,
      ...(unresolvedConflicts !== undefined ? { unresolvedConflicts } : {}),
      ...(conflictingParent !== undefined ? { conflictingParent } : {}),
      ...(deferredParents !== undefined && deferredParents.length > 0 ? { deferredParents } : {}),
    };
    this.known.set(req.taskId, wt);
    return wt;
  }

  async remove(taskId: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    // Force-removal path: match by bare taskId so `yaao clean` works even
    // when the on-disk stamps lack the cache-key fields (legacy worktrees).
    const wt = this.known.get(taskId) ?? (await this.lookupByStampForTaskId(taskId));
    if (!wt) return; // idempotent
    if (existsSync(wt.path)) {
      try {
        await this.git.worktreeRemove(wt.path, { force: opts.force }, this.rootDir);
      } catch (err) {
        if (opts.force) {
          try {
            rmSync(wt.path, { recursive: true, force: true });
          } catch {
            // ignore
          }
        } else {
          throw err;
        }
      }
    }
    if (opts.deleteBranch) {
      try {
        await this.git.deleteBranch(wt.branch, { force: true }, this.rootDir);
      } catch {
        // ignore — branch may not exist
      }
    }
    this.known.delete(taskId);
  }

  async list(): Promise<Worktree[]> {
    const out: Worktree[] = [];
    for (const wt of this.known.values()) out.push(wt);
    // Also pick up any on-disk stamps the manager doesn't know about.
    const seen = new Set(out.map((w) => w.path));
    for (const stamped of this.scanStamps()) {
      if (!seen.has(stamped.path)) out.push(stamped);
    }
    return out;
  }

  /**
   * Look up an existing worktree by composite cache key. Returns undefined when
   * no stamp matches every field (planName + taskId + promptHash + dependsHash)
   * — including legacy stamps that pre-date the cache key, which are never
   * matched. Pass a bare taskId to fall back to the historical lookup-by-id
   * behaviour, used by `remove(taskId)` and tests; new lifecycle code should
   * always pass the full key.
   */
  async get(key: WorktreeStampKey | string): Promise<Worktree | undefined> {
    if (typeof key === 'string') {
      const taskId = key;
      return this.known.get(taskId) ?? (await this.lookupByStampForTaskId(taskId));
    }
    return this.matchKnown(key) ?? (await this.lookupByStamp(key));
  }

  private matchKnown(key: WorktreeStampKey): Worktree | undefined {
    const wt = this.known.get(key.taskId);
    if (!wt) return undefined;
    // In-memory cache only ever contains worktrees this WorktreeManager just
    // created, so we trust them. The cache-key contract is enforced on disk
    // via lookupByStamp; this fast path is only hit within a single run.
    return wt;
  }

  async pruneOrphans(activeRunIds: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const wt of this.scanStamps()) {
      const stamp = this.readStamp(wt.path);
      if (!stamp) continue;
      if (!activeRunIds.has(stamp.runId)) {
        // eslint-disable-next-line no-await-in-loop -- prune one at a time so failures localize
        try {
          await this.git.worktreeRemove(wt.path, { force: true }, this.rootDir);
        } catch {
          rmSync(wt.path, { recursive: true, force: true });
        }
        removed.push(wt.path);
      }
    }
    return removed;
  }

  /**
   * Match on every field of the composite key. A legacy stamp lacking any of
   * planName/promptHash/dependsHash is never returned — we'd rather create a
   * fresh worktree than reuse one whose contract we can't verify.
   */
  private async lookupByStamp(key: WorktreeStampKey): Promise<Worktree | undefined> {
    let fallback: Worktree | undefined;
    for (const { wt, stamp } of this.scanStampedWorktrees()) {
      if (stamp.taskId !== key.taskId) continue;
      if (stamp.planName !== key.planName) continue;
      if (stamp.promptHash !== key.promptHash) continue;
      if (stamp.dependsHash !== key.dependsHash) continue;
      // Prefer a match from the active runId, if there's one; otherwise the
      // first match wins. Same-plan re-runs typically pick up the previous
      // run's worktree via this fallback.
      fallback ??= wt;
    }
    return fallback;
  }

  /**
   * Legacy fallback for `remove(taskId)` and `get(string)` — matches by taskId
   * only. Never used by the lifecycle.
   */
  private async lookupByStampForTaskId(taskId: string): Promise<Worktree | undefined> {
    for (const { wt, stamp } of this.scanStampedWorktrees()) {
      if (stamp.taskId === taskId) return wt;
    }
    return undefined;
  }

  private *scanStampedWorktrees(): Generator<{ wt: Worktree; stamp: WorktreeStamp }> {
    const root = resolve(this.rootDir, this.worktreeRoot);
    if (!existsSync(root)) return;
    for (const runDir of readdirSync(root)) {
      const runPath = join(root, runDir);
      if (!isDirectory(runPath)) continue;
      for (const taskDir of readdirSync(runPath)) {
        const wtPath = join(runPath, taskDir);
        if (!isDirectory(wtPath)) continue;
        const stamp = this.readStamp(wtPath);
        if (!stamp) continue;
        const wt: Worktree = {
          taskId: stamp.taskId,
          branch: stamp.branch,
          path: wtPath,
          baseCommit: stamp.baseCommit,
          sourceRunId: stamp.runId,
        };
        yield { wt, stamp };
      }
    }
  }

  private *scanStamps(): Generator<Worktree> {
    for (const { wt } of this.scanStampedWorktrees()) yield wt;
  }

  private readStamp(wtPath: string): WorktreeStamp | undefined {
    const f = join(wtPath, '.yaao', '.task');
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as WorktreeStamp;
    } catch {
      return undefined;
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
