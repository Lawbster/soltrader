type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'INFO';

function timestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, module: string, msg: string, data?: unknown) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const entry = {
    time: timestamp(),
    level,
    module,
    msg,
    ...(data !== undefined && { data }),
  };

  const line = JSON.stringify(entry);

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: unknown) => log('DEBUG', module, msg, data),
    info: (msg: string, data?: unknown) => log('INFO', module, msg, data),
    warn: (msg: string, data?: unknown) => log('WARN', module, msg, data),
    error: (msg: string, data?: unknown) => log('ERROR', module, msg, data),
  };
}
