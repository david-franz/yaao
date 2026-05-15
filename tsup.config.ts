import { defineConfig } from 'tsup';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as { version: string };
const define = { __YAAO_VERSION__: JSON.stringify(pkg.version) };

export default defineConfig([
  {
    entry: { 'bin/yaao': 'src/bin/yaao.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    dts: false,
    sourcemap: true,
    splitting: false,
    shims: false,
    banner: { js: '#!/usr/bin/env node' },
    define,
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: false,
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    define,
    async onSuccess() {
      // Built-in skills are data files; copy them next to the bundle so the
      // production binary can resolve them via dist/skills/builtin/<name>/.
      const src = join(here, 'src', 'skills', 'builtin');
      const dst = join(here, 'dist', 'skills', 'builtin');
      mkdirSync(dst, { recursive: true });
      cpSync(src, dst, { recursive: true });
    },
  },
]);
