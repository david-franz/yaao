import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
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
  },
]);
