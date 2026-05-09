import { createRequire } from 'node:module';

declare const __YAAO_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __YAAO_VERSION__ === 'string') return __YAAO_VERSION__;
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

export const VERSION: string = readVersion();
