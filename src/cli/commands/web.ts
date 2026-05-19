import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { startWebServer } from '../../web/server.js';

interface WebFlags {
  host?: string;
  port?: string;
  open?: boolean;
}

export const webCommand: CommandModule = {
  name: 'web',
  describe: 'Start the yaao web viewer (HTTP + SSE) on a local port',
  register(program: Command, ctx: CliContext) {
    program
      .command('web')
      .description('Start the yaao web viewer on a local port')
      .option('--host <host>', 'bind host (non-loopback requires --token)', '127.0.0.1')
      .option('--port <n>', 'bind port (0 = kernel-assigned)', '0')
      .option('--no-open', "don't auto-open a browser (no-op in F13.0)")
      .action(async (flags: WebFlags) => {
        const portN = Number(flags.port ?? '0');
        if (!Number.isFinite(portN) || portN < 0) {
          ctx.logger.error(`invalid --port: ${flags.port}`);
          ctx.exit(2);
          return;
        }
        const handle = await startWebServer({
          cwd: resolve(ctx.cwd),
          host: flags.host ?? '127.0.0.1',
          port: portN,
        });
        // Print to stderr (not stdout) so the bound URL doesn't pollute
        // anyone piping `yaao web` output into another command. Two lines:
        // the URL itself on its own line (parseable), then a hint.
        process.stderr.write(`http://${handle.host}:${handle.port}\n`);
        process.stderr.write(`yaao web: ready · Ctrl-C to stop\n`);

        // Hold the process until SIGINT.
        await new Promise<void>((res) => {
          const onSig = (): void => {
            process.off('SIGINT', onSig);
            process.off('SIGTERM', onSig);
            void handle.close().then(() => res());
          };
          process.on('SIGINT', onSig);
          process.on('SIGTERM', onSig);
        });
        ctx.exit(0);
      });
  },
};
