import pino from 'pino';
import { config } from './config.js';

/**
 * Structured JSON logging with levels. Even at Stage 00 we log structured so
 * that when we grow we can ship logs to an aggregator without changing code.
 * We log to stdout (the 12-factor way); a supervisor/container collects it.
 */
export const logger = pino({ level: config.LOG_LEVEL });
