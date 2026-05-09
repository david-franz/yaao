import { VERSION } from '../version.js';

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        `yaao ${VERSION} — yet another agent orchestrator`,
        '',
        'Usage:',
        '  yaao <command> [options]',
        '',
        'CLI commands land in F1.2; this is the F1.1 seed.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  process.stderr.write(`yaao: unknown command "${args[0]}"\n`);
  return 2;
}

main(process.argv).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`yaao: unexpected error\n${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(99);
  },
);
