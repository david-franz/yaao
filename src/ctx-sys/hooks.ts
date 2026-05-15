import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const HOOK_BEGIN = '# >>> yaao-ctx-sys';
export const HOOK_END = '# <<< yaao-ctx-sys';

const HOOK_BODY = [
  HOOK_BEGIN,
  '# Managed by yaao: produces .yaao/impact-report.json for the merge-resolver agent.',
  '# Non-blocking — if ctx-sys is unavailable the hook still exits 0.',
  'if command -v ctx-sys >/dev/null 2>&1; then',
  '  mkdir -p .yaao',
  '  STAGED_DIFF=$(git diff --cached) || STAGED_DIFF=""',
  '  if [ -n "$STAGED_DIFF" ]; then',
  '    echo "$STAGED_DIFF" | ctx-sys hooks impact-report --diff - > .yaao/impact-report.json 2>/dev/null || true',
  '  fi',
  'else',
  '  echo "yaao: ctx-sys not on PATH; skipping impact report" >&2',
  'fi',
  HOOK_END,
].join('\n');

export interface InstallHookOptions {
  cwd: string;
}

export interface InstallHookResult {
  status: 'installed' | 'updated' | 'unchanged' | 'no-git';
  path?: string;
}

/**
 * Install (or update) the yaao-managed pre-commit hook block. Idempotent: rerunning is
 * a no-op when the block already matches. Preserves any user content above/below the
 * managed delimiters.
 */
export function installCtxSysHook(opts: InstallHookOptions): InstallHookResult {
  const cwd = resolve(opts.cwd);
  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) return { status: 'no-git' };
  const hookPath = join(gitDir, 'hooks', 'pre-commit');
  mkdirSync(dirname(hookPath), { recursive: true });

  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '#!/bin/sh\n';
  const begin = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END);
  let next: string;
  let status: InstallHookResult['status'];
  if (begin === -1 && end === -1) {
    const sep = existing.endsWith('\n') ? '' : '\n';
    next = `${existing}${sep}${HOOK_BODY}\n`;
    status = 'installed';
  } else if (begin !== -1 && end !== -1 && end > begin) {
    const current = existing.slice(begin, end + HOOK_END.length);
    if (current === HOOK_BODY) {
      // Already matches; only touch perms.
      chmodSync(hookPath, 0o755);
      return { status: 'unchanged', path: hookPath };
    }
    next = `${existing.slice(0, begin)}${HOOK_BODY}${existing.slice(end + HOOK_END.length)}`;
    status = 'updated';
  } else {
    // Malformed (one delimiter present); refuse to mangle.
    return { status: 'unchanged', path: hookPath };
  }
  writeFileSync(hookPath, next);
  chmodSync(hookPath, 0o755);
  return { status, path: hookPath };
}

export interface RemoveHookResult {
  status: 'removed' | 'absent' | 'no-git';
  path?: string;
}

/** Strip the yaao-managed block from `.git/hooks/pre-commit`, preserving user content. */
export function removeCtxSysHook(opts: InstallHookOptions): RemoveHookResult {
  const cwd = resolve(opts.cwd);
  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) return { status: 'no-git' };
  const hookPath = join(gitDir, 'hooks', 'pre-commit');
  if (!existsSync(hookPath)) return { status: 'absent' };
  const existing = readFileSync(hookPath, 'utf8');
  const begin = existing.indexOf(HOOK_BEGIN);
  const end = existing.indexOf(HOOK_END);
  if (begin === -1 || end === -1 || end <= begin) return { status: 'absent', path: hookPath };
  // Also chomp the trailing newline that followed the END delimiter.
  let cutEnd = end + HOOK_END.length;
  if (existing[cutEnd] === '\n') cutEnd += 1;
  // And trim a separating newline before BEGIN if it leaves a double-blank line.
  let cutBegin = begin;
  if (cutBegin > 0 && existing[cutBegin - 1] === '\n' && existing[cutBegin - 2] === '\n') {
    cutBegin -= 1;
  }
  const next = `${existing.slice(0, cutBegin)}${existing.slice(cutEnd)}`;
  writeFileSync(hookPath, next);
  return { status: 'removed', path: hookPath };
}
