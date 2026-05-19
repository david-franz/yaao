import { execa } from 'execa';
import { GitError } from '../log/errors.js';

export interface GitFile {
  path: string;
  /**
   * Two-letter porcelain status code per `git status --porcelain=v2`. For renames,
   * `path` is the destination and `origPath` is the source.
   */
  xy: string;
  origPath?: string;
}

export interface GitStatus {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  untracked: string[];
  renamed: GitFile[];
}

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  mergeCommit?: string;
}

export interface DiffOpts {
  staged?: boolean;
  nameOnly?: boolean;
  ref?: string;
  rangeBase?: string;
}

export interface LogOpts {
  ref?: string;
  limit?: number;
  format?: string;
}

export interface LogEntry {
  sha: string;
  subject: string;
  authorEmail: string;
  date: string;
}

export interface PlanGitState {
  /** True when the file is recorded in HEAD's tree. */
  tracked: boolean;
  /** True when the working-tree copy differs from HEAD (modified or staged). */
  dirty: boolean;
  /** The committed blob SHA in HEAD, when tracked. Anchors a run to a real commit. */
  blobSha?: string;
  /** HEAD commit SHA at the moment of the check. */
  headSha?: string;
}

export interface Git {
  rootDir(cwd?: string): Promise<string>;
  isRepo(cwd?: string): Promise<boolean>;
  currentBranch(cwd?: string): Promise<string>;
  status(cwd?: string): Promise<GitStatus>;
  hasUncommitted(cwd?: string): Promise<boolean>;
  /**
   * Inspect a single file's git state. Used by `yaao run` to refuse starting
   * when the plan file isn't anchored to a commit — otherwise the audit trail
   * is half-broken (you'd have commits made from an unrecorded plan).
   */
  planFileState(path: string, cwd?: string): Promise<PlanGitState>;
  /**
   * Returns the SHA of the most recent commit that touched `path`, or
   * undefined when the path isn't tracked. Cheap join used by `yaao_inspect`
   * to anchor each plan to a commit without forcing callers to shell out.
   */
  lastCommitFor(path: string, cwd?: string): Promise<string | undefined>;
  revParse(ref: string, cwd?: string): Promise<string>;
  branchExists(branch: string, cwd?: string): Promise<boolean>;
  /**
   * True when `commit` is an ancestor of `ref` — i.e. every commit reachable
   * from `commit` is also reachable from `ref`. Used by cleanup logic to
   * recognise that a branch whose tip equals base's tip (or is reachable from
   * base) carries no unique commits and is therefore safe to delete, even if
   * yaao's journal never recorded an explicit merge for it.
   */
  isAncestor(commit: string, ref: string, cwd?: string): Promise<boolean>;
  createBranch(branch: string, base: string, cwd?: string): Promise<void>;
  deleteBranch(branch: string, opts?: { force?: boolean }, cwd?: string): Promise<void>;
  worktreeAdd(path: string, branch: string, cwd?: string): Promise<void>;
  worktreeRemove(path: string, opts?: { force?: boolean }, cwd?: string): Promise<void>;
  worktreeList(cwd?: string): Promise<WorktreeInfo[]>;
  merge(
    branch: string,
    opts?: { ff?: boolean; noEdit?: boolean; message?: string },
    cwd?: string,
  ): Promise<MergeResult>;
  mergeAbort(cwd?: string): Promise<void>;
  /**
   * Merge `source` into `target` without touching the root working tree.
   *
   * - `mode: 'merge'` (default): computes the merged tree via
   *   `git merge-tree --write-tree`, creates a merge commit via
   *   `git commit-tree`, fast-forwards the target ref via `update-ref`.
   *   No working tree is touched.
   * - `mode: 'rebase'`: replays source's commits onto target via a detached
   *   transient worktree, then updates the target ref to the rebased tip.
   *   Linear history; on conflict the rebase is aborted and `ok: false` is
   *   returned with the conflicting paths.
   *
   * Either mode works when the target branch is checked out at the user's
   * root repo or in another worktree.
   */
  mergeRefs(
    target: string,
    source: string,
    opts: { message: string; mode?: 'merge' | 'rebase' },
    cwd?: string,
  ): Promise<MergeResult>;
  /**
   * Advance `target` to `newSha`. Prefers `git reset --keep` when `target`
   * is the current branch at `cwd` (atomically updates head + index +
   * working tree), falls back to `update-ref` otherwise. Aborts the reset
   * if local changes would be lost.
   */
  advanceRef(target: string, newSha: string, expectedOld: string, cwd?: string): Promise<void>;
  diff(opts?: DiffOpts, cwd?: string): Promise<string>;
  log(opts?: LogOpts, cwd?: string): Promise<LogEntry[]>;
  push(remote: string, branch: string, opts?: { setUpstream?: boolean }, cwd?: string): Promise<void>;
  fetch(remote?: string, refspec?: string, cwd?: string): Promise<void>;
  version(): Promise<string>;
  add(paths: string[], cwd?: string): Promise<void>;
  addAll(cwd?: string): Promise<void>;
  commit(message: string, opts?: { allowEmpty?: boolean }, cwd?: string): Promise<string>;
}

const GIT_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string | undefined): Promise<RunResult> {
  const r = await execa('git', args, {
    cwd,
    env: GIT_ENV,
    reject: false,
    all: false,
    stripFinalNewline: false,
  });
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
  };
}

/**
 * Move `target` to `newSha` in a way that respects the user's working tree.
 * Plain `update-ref` advances the branch ref but leaves the index + working
 * tree pointing at the old commit — so if `target` happens to be checked out
 * at `cwd` (typical: the user's `main` checkout at the repo root), every
 * file in the new commit shows up as a "staged deletion" in `git status`.
 *
 * When `target === HEAD`'s current branch at `cwd`, we use `git reset --keep`
 * instead, which atomically advances the head, index, and working tree —
 * and aborts safely if the user has work in progress that would be lost.
 * In the fallback path (--keep refused, or target isn't checked out here),
 * we use update-ref so the merge still records on the branch.
 */
async function advanceTargetRef(
  target: string,
  newSha: string,
  expectedOld: string,
  cwd: string | undefined,
): Promise<void> {
  const cur = await run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const currentBranch = cur.exitCode === 0 ? cur.stdout.trim() : '';
  if (currentBranch === target) {
    const reset = await run(['reset', '--keep', newSha], cwd);
    if (reset.exitCode === 0) return;
    // `--keep` refused because the working tree has uncommitted changes.
    // Fall through to update-ref so the run still records the merge on the
    // branch, but the user's checkout will fall behind — they can sync with
    // `git checkout .` once their WIP is dealt with.
  }
  await runOk(['update-ref', `refs/heads/${target}`, newSha, expectedOld], cwd);
}

async function runOk(args: string[], cwd: string | undefined): Promise<string> {
  const r = await run(args, cwd);
  if (r.exitCode !== 0) {
    throw new GitError({
      message: `git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      cmd: ['git', ...args],
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }
  return r.stdout;
}

export const git: Git = {
  async rootDir(cwd) {
    return (await runOk(['rev-parse', '--show-toplevel'], cwd)).trim();
  },
  async isRepo(cwd) {
    const r = await run(['rev-parse', '--is-inside-work-tree'], cwd);
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  },
  async currentBranch(cwd) {
    const out = await runOk(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return out.trim();
  },
  async status(cwd) {
    const out = await runOk(['status', '--porcelain=v2', '--branch', '--untracked-files=all'], cwd);
    return parseStatus(out);
  },
  async hasUncommitted(cwd) {
    const s = await this.status(cwd);
    return s.files.length > 0 || s.untracked.length > 0 || s.renamed.length > 0;
  },
  async planFileState(path, cwd) {
    // ls-files --error-unmatch: exits 0 iff the path is tracked at HEAD's tree.
    const ls = await run(['ls-files', '--error-unmatch', '--', path], cwd);
    const tracked = ls.exitCode === 0;
    if (!tracked) return { tracked: false, dirty: true };
    // diff --quiet HEAD -- path: exits 0 when working-tree matches HEAD.
    // Captures both staged and unstaged changes against the recorded blob.
    const diff = await run(['diff', '--quiet', 'HEAD', '--', path], cwd);
    const dirty = diff.exitCode !== 0;
    const blob = await run(['rev-parse', `HEAD:${path}`], cwd);
    const head = await run(['rev-parse', 'HEAD'], cwd);
    const out: PlanGitState = { tracked: true, dirty };
    if (blob.exitCode === 0) out.blobSha = blob.stdout.trim();
    if (head.exitCode === 0) out.headSha = head.stdout.trim();
    return out;
  },
  async lastCommitFor(path, cwd) {
    const r = await run(['log', '-1', '--format=%H', '--', path], cwd);
    if (r.exitCode !== 0) return undefined;
    const sha = r.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  },
  async revParse(ref, cwd) {
    return (await runOk(['rev-parse', '--verify', ref], cwd)).trim();
  },
  async branchExists(branch, cwd) {
    const r = await run(['rev-parse', '--verify', `refs/heads/${branch}`], cwd);
    return r.exitCode === 0;
  },
  async isAncestor(commit, ref, cwd) {
    // `merge-base --is-ancestor` exits 0 if true, 1 if false, other on error.
    // Treat errors (bad ref, missing branch, etc.) as "not an ancestor" so
    // callers default to the safer "don't assume merged" interpretation.
    const r = await run(['merge-base', '--is-ancestor', commit, ref], cwd);
    return r.exitCode === 0;
  },
  async createBranch(branch, base, cwd) {
    await runOk(['branch', branch, base], cwd);
  },
  async deleteBranch(branch, opts, cwd) {
    const flag = opts?.force ? '-D' : '-d';
    await runOk(['branch', flag, branch], cwd);
  },
  async worktreeAdd(path, branch, cwd) {
    await runOk(['worktree', 'add', path, branch], cwd);
  },
  async worktreeRemove(path, opts, cwd) {
    const args = ['worktree', 'remove', path];
    if (opts?.force) args.splice(2, 0, '--force');
    await runOk(args, cwd);
  },
  async worktreeList(cwd) {
    const out = await runOk(['worktree', 'list', '--porcelain'], cwd);
    return parseWorktreeList(out);
  },
  async merge(branch, opts, cwd) {
    const args = ['merge'];
    if (opts?.ff === false) args.push('--no-ff');
    if (opts?.noEdit !== false) args.push('--no-edit');
    if (opts?.message) args.push('-m', opts.message);
    args.push(branch);
    const r = await run(args, cwd);
    if (r.exitCode === 0) {
      const head = (await run(['rev-parse', 'HEAD'], cwd)).stdout.trim();
      return { ok: true, conflicts: [], mergeCommit: head };
    }
    // Detect conflict via `git diff --name-only --diff-filter=U`
    const diff = await run(['diff', '--name-only', '--diff-filter=U'], cwd);
    if (diff.exitCode === 0 && diff.stdout.trim().length > 0) {
      return {
        ok: false,
        conflicts: diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      };
    }
    throw new GitError({
      message: `git merge ${branch} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      cmd: ['git', ...args],
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  },
  async mergeAbort(cwd) {
    await runOk(['merge', '--abort'], cwd);
  },
  async advanceRef(target, newSha, expectedOld, cwd) {
    await advanceTargetRef(target, newSha, expectedOld, cwd);
  },
  async mergeRefs(target, source, opts, cwd) {
    const mode = opts.mode ?? 'merge';
    // Resolve tip commits of both sides for either mode.
    const targetSha = (await run(['rev-parse', '--verify', target], cwd)).stdout.trim();
    const sourceSha = (await run(['rev-parse', '--verify', source], cwd)).stdout.trim();
    if (!targetSha || !sourceSha) {
      throw new GitError({
        message: `mergeRefs: unable to resolve ${!targetSha ? target : source}`,
        cmd: ['git', 'rev-parse', target, source],
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
    }
    if (mode === 'merge') {
      // 1) Compute the merge tree. Modern git (2.38+) prints the resulting
      //    tree SHA on stdout for a clean merge, exits 1 on conflict.
      const mt = await run(['merge-tree', '--write-tree', '--', target, source], cwd);
      if (mt.exitCode !== 0) {
        const conflicts = (mt.stdout + '\n' + mt.stderr)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.match(/^[0-9a-f]{40,}$/) && !l.startsWith('CONFLICT') && l.includes('/'));
        return { ok: false, conflicts };
      }
      const treeSha = mt.stdout.trim().split(/\r?\n/)[0] ?? '';
      // 2) Build a merge commit pointing at both parents.
      const ct = await run(
        ['commit-tree', treeSha, '-p', targetSha, '-p', sourceSha, '-m', opts.message],
        cwd,
      );
      if (ct.exitCode !== 0) {
        throw new GitError({
          message: `mergeRefs: commit-tree failed: ${ct.stderr.trim() || ct.stdout.trim()}`,
          cmd: ['git', 'commit-tree'],
          exitCode: ct.exitCode,
          stdout: ct.stdout,
          stderr: ct.stderr,
        });
      }
      const mergeCommit = ct.stdout.trim();
      // 3) Advance the target ref. If `target` is also the branch checked out
      // at `cwd` (typical: user's main checkout at the repo root), use
      // `git reset --keep` to move the head + index + working tree together.
      // Plain `update-ref` would leave the user's working tree and index
      // pointing at the OLD commit, and `git status` would then report every
      // newly-merged file as a staged deletion. `--keep` aborts safely if
      // the working tree has changes that would be lost; we fall back to
      // plain update-ref in that case (the user keeps their WIP and can
      // sync the checkout themselves).
      await advanceTargetRef(target, mergeCommit, targetSha, cwd);
      return { ok: true, conflicts: [], mergeCommit };
    }
    // mode === 'rebase'
    const baseRes = await run(['merge-base', target, source], cwd);
    if (baseRes.exitCode !== 0) {
      return { ok: false, conflicts: [] };
    }
    const mergeBase = baseRes.stdout.trim();
    // Already up to date: source's tip is ancestor of target. No-op.
    if (mergeBase === sourceSha) return { ok: true, conflicts: [], mergeCommit: targetSha };
    // Detached transient worktree under .yaao so `yaao clean` reclaims it
    // if anything below leaves residue.
    const safe = `${target}_${source}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpPath = `${cwd ?? '.'}/.yaao/runs/_rebase-${safe}-${Date.now().toString(36)}`;
    try {
      const addRes = await run(['worktree', 'add', '--detach', tmpPath, source], cwd);
      if (addRes.exitCode !== 0) {
        return { ok: false, conflicts: [] };
      }
    } catch {
      return { ok: false, conflicts: [] };
    }
    try {
      const reb = await run(['rebase', '--onto', target, mergeBase], tmpPath);
      if (reb.exitCode !== 0) {
        // Capture conflicted paths before aborting.
        const unmerged = await run(['diff', '--name-only', '--diff-filter=U'], tmpPath);
        const conflicts = unmerged.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        try {
          await run(['rebase', '--abort'], tmpPath);
        } catch {
          // ignore — already failing
        }
        return { ok: false, conflicts };
      }
      const newHead = (await run(['rev-parse', 'HEAD'], tmpPath)).stdout.trim();
      // Same dance as merge mode: prefer `git reset --keep` when target is
      // the cwd's current branch, so the user's working tree and index stay
      // in sync with the new HEAD.
      await advanceTargetRef(target, newHead, targetSha, cwd);
      return { ok: true, conflicts: [], mergeCommit: newHead };
    } finally {
      try {
        await run(['worktree', 'remove', '--force', tmpPath], cwd);
      } catch {
        // ignore — best effort cleanup
      }
    }
  },
  async diff(opts, cwd) {
    const args = ['diff'];
    if (opts?.staged) args.push('--staged');
    if (opts?.nameOnly) args.push('--name-only');
    if (opts?.rangeBase) args.push(`${opts.rangeBase}...HEAD`);
    else if (opts?.ref) args.push(opts.ref);
    return await runOk(args, cwd);
  },
  async log(opts, cwd) {
    const fmt = opts?.format ?? '%H%x09%s%x09%ae%x09%aI';
    const args = ['log', `--pretty=format:${fmt}`];
    if (opts?.limit) args.push(`-n${opts.limit}`);
    if (opts?.ref) args.push(opts.ref);
    const out = await runOk(args, cwd);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, authorEmail, date] = line.split('\t');
        return { sha: sha ?? '', subject: subject ?? '', authorEmail: authorEmail ?? '', date: date ?? '' };
      });
  },
  async push(remote, branch, opts, cwd) {
    const args = ['push'];
    if (opts?.setUpstream) args.push('-u');
    args.push(remote, branch);
    await runOk(args, cwd);
  },
  async fetch(remote, refspec, cwd) {
    const args = ['fetch'];
    if (remote) args.push(remote);
    if (refspec) args.push(refspec);
    await runOk(args, cwd);
  },
  async version() {
    const out = await runOk(['--version'], undefined);
    return out.trim().replace(/^git version /, '');
  },
  async add(paths, cwd) {
    await runOk(['add', '--', ...paths], cwd);
  },
  async addAll(cwd) {
    await runOk(['add', '-A'], cwd);
  },
  async commit(message, opts, cwd) {
    const args = ['commit', '-m', message];
    if (opts?.allowEmpty) args.push('--allow-empty');
    await runOk(args, cwd);
    return (await runOk(['rev-parse', 'HEAD'], cwd)).trim();
  },
};

export function parseStatus(porcelain: string): GitStatus {
  const status: GitStatus = {
    ahead: 0,
    behind: 0,
    files: [],
    untracked: [],
    renamed: [],
  };
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      status.branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      // "+N -M"
      const m = line.slice('# branch.ab '.length).match(/\+(-?\d+) -(\d+)/);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line.startsWith('? ')) {
      status.untracked.push(line.slice(2));
    } else if (line.startsWith('1 ')) {
      // changed entry: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = line.split(' ');
      const xy = parts[1] ?? '';
      const path = parts.slice(8).join(' ');
      status.files.push({ xy, path });
    } else if (line.startsWith('2 ')) {
      // renamed: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>
      const parts = line.split(' ');
      const xy = parts[1] ?? '';
      const tail = parts.slice(9).join(' ');
      const [path, orig] = tail.split('\t');
      const file: GitFile = { xy, path: path ?? '', origPath: orig };
      status.renamed.push(file);
      status.files.push(file);
    }
  }
  return status;
}

export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current) {
      if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'bare') current.bare = true;
      else if (line === 'detached') current.detached = true;
      else if (line === '' && current) {
        out.push(current);
        current = undefined;
      }
    }
  }
  if (current) out.push(current);
  return out;
}
