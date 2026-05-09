export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  stream?: NodeJS.WritableStream;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export function createLogger(opts: LoggerOptions): Logger {
  const stream = opts.stream ?? process.stderr;
  const minRank = LEVEL_RANK[opts.level];
  return makeLogger({}, opts.format, minRank, stream);
}

function makeLogger(
  bindings: Record<string, unknown>,
  format: LogFormat,
  minRank: number,
  stream: NodeJS.WritableStream,
): Logger {
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[level] < minRank) return;
    const merged = { ...bindings, ...fields };
    if (format === 'json') {
      stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...merged })}\n`);
    } else {
      const tag = `[${level.toUpperCase()}]`.padEnd(7);
      const extra = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : '';
      stream.write(`${tag} ${msg}${extra}\n`);
    }
  };
  return {
    trace: (m, f) => log('trace', m, f),
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) => makeLogger({ ...bindings, ...b }, format, minRank, stream),
  };
}
