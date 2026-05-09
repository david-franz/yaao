import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpProject {
  path: string;
  write(rel: string, contents: string): void;
  cleanup(): void;
}

export function createTmpProject(): TmpProject {
  const path = mkdtempSync(join(tmpdir(), 'yaao-test-'));
  const write = (rel: string, contents: string) => {
    const full = join(path, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  };
  const cleanup = () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  return { path, write, cleanup };
}
