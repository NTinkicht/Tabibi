import pino, { type Logger } from 'pino';
import { getEnvironment } from '@/platform/config/env';

let logger: Logger | undefined;

export function getLogger(): Logger {
  logger ??= pino({
    level: getEnvironment().LOG_LEVEL,
    base: { service: 'tabibi' },
    redact: {
      paths: [
        'password',
        'token',
        'authorization',
        'cookie',
        '*.password',
        '*.token',
        '*.phone',
        '*.patientName',
      ],
      censor: '[REDACTED]',
    },
  });
  return logger;
}
