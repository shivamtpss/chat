import pino from 'pino';
import { config } from './config.js';

/** Component id (server or worker) is bound to every log line for clarity. */
export function makeLogger(component: string) {
  return pino({ level: config.LOG_LEVEL }).child({ component });
}
