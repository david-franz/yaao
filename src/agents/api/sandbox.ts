import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { execaSync } from 'execa';
import { ApiToolError } from '../../log/errors.js';

export interface ToolSandboxOptions {
  cwd: string;
}

export class ToolSandbox {
  private readonly cwd: string;

  constructor(opts: ToolSandboxOptions) {
    this.cwd = resolve(opts.cwd);
  }

  /** Resolve a user-provided path against `cwd`. Reject absolute paths and `..` traversal. */
  resolveSafe(path: string): string {
    if (typeof path !== 'string' || path.length === 0) {
      throw new ApiToolError({ message: 'tool path is empty', tool: 'resolveSafe' });
    }
    if (isAbsolute(path)) {
      throw new ApiToolError({ message: `absolute paths not allowed: ${path}`, tool: 'resolveSafe' });
    }
    const abs = resolve(this.cwd, path);
    const rel = relative(this.cwd, abs);
    if (rel.startsWith('..') || rel === '..') {
      throw new ApiToolError({
        message: `path escapes worktree: ${path}`,
        tool: 'resolveSafe',
      });
    }
    return abs;
  }

  readFile(path: string): string {
    const abs = this.resolveSafe(path);
    if (!existsSync(abs)) {
      throw new ApiToolError({ message: `file not found: ${path}`, tool: 'read_file' });
    }
    return readFileSync(abs, 'utf8');
  }

  writeFile(path: string, contents: string): { bytes: number } {
    const abs = this.resolveSafe(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    return { bytes: Buffer.byteLength(contents, 'utf8') };
  }

  listFiles(glob?: string): string[] {
    const root = this.cwd;
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const s = statSync(full);
        if (s.isDirectory()) {
          // skip .git, node_modules, .yaao for sanity
          if (name === '.git' || name === 'node_modules' || name === '.yaao') continue;
          walk(full);
        } else if (s.isFile()) {
          out.push(relative(root, full));
        }
      }
    };
    walk(root);
    if (!glob) return out;
    const re = globToRegex(glob);
    return out.filter((p) => re.test(p));
  }

  applyPatch(diff: string): { filesChanged: number } {
    if (typeof diff !== 'string' || diff.length === 0) {
      throw new ApiToolError({ message: 'apply_patch: diff is empty', tool: 'apply_patch' });
    }
    // Use `git apply --3way` so a clean diff is applied even on a non-git target.
    const r = execaSync('git', ['apply', '--whitespace=nowarn'], {
      cwd: this.cwd,
      input: diff,
      reject: false,
    });
    if (r.exitCode !== 0) {
      throw new ApiToolError({
        message: `apply_patch failed: ${r.stderr?.toString() ?? r.stdout?.toString() ?? '(no output)'}`,
        tool: 'apply_patch',
      });
    }
    // Count files changed by counting `+++ ` lines in the diff (cheap heuristic).
    const filesChanged = (diff.match(/^\+\+\+ /gm) ?? []).length;
    return { filesChanged };
  }

  runShell(cmd: string, timeoutMs = 30_000): { stdout: string; stderr: string; exitCode: number } {
    if (typeof cmd !== 'string' || cmd.length === 0) {
      throw new ApiToolError({ message: 'run_shell: cmd is empty', tool: 'run_shell' });
    }
    const r = execaSync('sh', ['-c', cmd], {
      cwd: this.cwd,
      reject: false,
      timeout: timeoutMs,
    });
    return {
      stdout: r.stdout?.toString() ?? '',
      stderr: r.stderr?.toString() ?? '',
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
    };
  }
}

function globToRegex(glob: string): RegExp {
  // Tiny glob: handles * and ** only. Sufficient for advisory file listings.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '.') {
      re += '\\.';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}
