#!/usr/bin/env node
// Copies the Vite bundle from `web/dist/` into `dist/web/` so the installed
// yaao binary (`dist/bin/yaao.js`) can resolve it via a relative URL
// against its own `import.meta.url`. Idempotent — clears the destination
// first.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const src = join(root, 'web', 'dist');
const dst = join(root, 'dist', 'web');

if (!existsSync(src)) {
  console.error(`copy-web-dist: ${src} does not exist — did the web build run?`);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copy-web-dist: ${src} → ${dst}`);
