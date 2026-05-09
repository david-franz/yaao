import { yaao } from '../cli/index.js';

yaao({ argv: process.argv }).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`yaao: unexpected error\n${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(99);
  },
);
