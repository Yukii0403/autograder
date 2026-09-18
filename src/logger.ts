/**
 * 结构化 JSON 日志。
 *
 * 规则：
 * - 每条日志必带 requestId，便于串联一次请求的全部事件
 * - 敏感字段一律脱敏：密钥、令牌、密码、Authorization
 * - 不记录学生姓名/学号与报告原文全文（只记长度与摘要）
 * - 单条字段值超过 MAX_STRING 会截断，避免把大文本写进日志
 *
 * 参见 docs/技术方案.md 第 12.4 节。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEY_PATTERN = /(key|secret|password|token|authorization|credential)/i;
const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > MAX_STRING) {
      return `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly base: LogFields = {},
  ) {}

  /** 派生一个带附加上下文的子 logger（例如绑定 requestId）。 */
  child(fields: LogFields): Logger {
    return new Logger(this.level, { ...this.base, ...fields });
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...redact(this.base) as LogFields,
      ...(fields ? redact(fields) as LogFields : {}),
    };

    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(event: string, fields?: LogFields): void { this.write('debug', event, fields); }
  info(event: string, fields?: LogFields): void  { this.write('info', event, fields); }
  warn(event: string, fields?: LogFields): void  { this.write('warn', event, fields); }
  error(event: string, fields?: LogFields): void { this.write('error', event, fields); }
}

export function createLogger(level: string): Logger {
  const safe: LogLevel = (['debug', 'info', 'warn', 'error'] as const).includes(level as LogLevel)
    ? (level as LogLevel)
    : 'info';
  return new Logger(safe);
}
