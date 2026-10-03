import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info');

const transport = process.env.NODE_ENV === 'development' 
  ? { target: 'pino-pretty', options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' } }
  : undefined;

export const logger = pino({
  level,
  transport,
});