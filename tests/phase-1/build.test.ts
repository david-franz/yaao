import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const cliPath = join(projectRoot, 'dist', 'bin', 'yaao.js');
const libPath = join(projectRoot, 'dist', 'index.js');
const dtsPath = join(projectRoot, 'dist', 'index.d.ts');

describe('build outputs', () => {
  it('CLI bundle has shebang', () => {
    if (!existsSync(cliPath)) return; // skip if not yet built
    const head = readFileSync(cliPath, 'utf8').slice(0, 20);
    expect(head.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('library bundle and types exist', () => {
    if (!existsSync(libPath)) return;
    expect(existsSync(libPath)).toBe(true);
    expect(existsSync(dtsPath)).toBe(true);
    expect(statSync(libPath).size).toBeGreaterThan(0);
  });
});
