import { yaao } from '../cli/index.js';
import { YaaoError } from '../log/errors.js';
import { isExitSignal } from '../cli/exit-signal.js';

yaao({ argv: process.argv }).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (isExitSignal(err)) {
      process.exit(err.exitCode);
    }
    if (err instanceof YaaoError) {
      process.stderr.write(`yaao: ${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
      process.exit(1);
    }
    const e = err as Error;
    process.stderr.write(`yaao: unexpected error\n${e?.stack ?? String(err)}\n`);
    process.exit(99);
  },
);
