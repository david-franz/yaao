import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the package-shipped built-in skills directory. In dev (tests, vitest) the
 * skills live under `src/skills/builtin/`; in the published bundle they're copied to
 * `dist/skills/builtin/` by tsup's `onSuccess` hook.
 */
export function getBuiltinSkillsDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/skills/builtin when this file is dist/index.js (we're inside dist/)
  const distCandidate = join(here, 'skills', 'builtin');
  if (existsSync(distCandidate)) return distCandidate;
  // src/skills/builtin when this file is src/skills/builtin-dir.ts (vitest path)
  const srcCandidate = join(here, 'builtin');
  if (existsSync(srcCandidate)) return srcCandidate;
  // Last resort: try walking up to find src/skills/builtin (running compiled tests from elsewhere)
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const c = join(dir, 'src', 'skills', 'builtin');
    if (existsSync(c)) return c;
    dir = dirname(dir);
  }
  return undefined;
}
