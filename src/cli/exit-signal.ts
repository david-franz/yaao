export const EXIT_SIGNAL = Symbol.for('yaao.cli.exit-signal');

export class ExitSignal extends Error {
  readonly [EXIT_SIGNAL] = true;
  readonly exitCode: number;
  constructor(code: number) {
    super(`yaao requested exit ${code}`);
    this.exitCode = code;
  }
}

export function isExitSignal(err: unknown): err is ExitSignal {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { [EXIT_SIGNAL]?: true })[EXIT_SIGNAL] === true
  );
}
