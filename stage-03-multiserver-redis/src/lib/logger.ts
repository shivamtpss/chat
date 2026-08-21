import pino from 'pino';
import { config } from './config.js';

/**
 * Structured logging, with the server id bound to every line so that when you
 * run servers A and B side by side you can tell which one did what.
 */
export const logger = pino({ level: config.LOG_LEVEL }).child({ server: config.SERVER_ID });
