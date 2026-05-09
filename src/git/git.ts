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

export interface Git {
  rootDir(cwd?: string): Promise<string>;
  isRepo(cwd?: string): Promise<boolean>;
  currentBranch(cwd?: string): Promise<string>;
  status(cwd?: string): Promise<GitStatus>;
  hasUncommitted(cwd?: string): Promise<boolean>;
  revParse(ref: string, cwd?: string): Promise<string>;
  branchExists(branch: string, cwd?: string): Promise<boolean>;
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
  diff(opts?: DiffOpts, cwd?: string): Promise<string>;
  log(opts?: LogOpts, cwd?: string): Promise<LogEntry[]>;
  push(remote: string, branch: string, opts?: { setUpstream?: boolean }, cwd?: string): Promise<void>;
  fetch(remote?: string, refspec?: string, cwd?: string): Promise<void>;
  version(): Promise<string>;
  add(paths: string[], cwd?: string): Promise<void>;
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
  async revParse(ref, cwd) {
    return (await runOk(['rev-parse', '--verify', ref], cwd)).trim();
  },
  async branchExists(branch, cwd) {
    const r = await run(['rev-parse', '--verify', `refs/heads/${branch}`], cwd);
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
