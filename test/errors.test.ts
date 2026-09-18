/**
 * 错误体系单元测试。
 *
 * 这些用例守的是「不泄漏内部细节」这条线：internal 只能进日志，绝不能出现在响应里。
 */
import { describe, it, expect } from 'vitest';
import {
  AppError,
  ConfigError,
  LlmError,
  ParseError,
  RateLimitedError,
  ValidationError,
  normalizeError,
} from '../src/errors';

describe('错误体系', () => {
  it('toResponse 只暴露 code、message 与 requestId', () => {
    const err = new ParseError('无法解析该文件', { sql: 'SELECT * FROM students', stack: 'at secret.ts:1' });
    const res = err.toResponse('req_abc');

    expect(res).toEqual({
      error: { code: 'PARSE_FAILED', message: '无法解析该文件' },
      requestId: 'req_abc',
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('secret.ts');
  });

  it('各错误类型的 code 与 httpStatus 对应正确', () => {
    expect(new ConfigError().code).toBe('CONFIG_MISSING');
    expect(new ConfigError().httpStatus).toBe(500);
    expect(new ValidationError().httpStatus).toBe(400);
    expect(new ParseError().httpStatus).toBe(422);
    expect(new LlmError().httpStatus).toBe(502);
    expect(new RateLimitedError().httpStatus).toBe(429);
  });

  it('normalizeError 原样透传 AppError', () => {
    const original = new LlmError('模型不可用');
    expect(normalizeError(original)).toBe(original);
  });

  it('normalizeError 把未知异常归一化为 INTERNAL，且不泄漏原始信息', () => {
    const raw = new Error('ECONNREFUSED 127.0.0.1:5432 password=hunter2');
    const normalized = normalizeError(raw);

    expect(normalized).toBeInstanceOf(AppError);
    expect(normalized.code).toBe('INTERNAL');
    expect(normalized.httpStatus).toBe(500);
    expect(normalized.message).toBe('服务器内部错误');
    expect(JSON.stringify(normalized.toResponse('req_1'))).not.toContain('hunter2');
  });

  it('normalizeError 处理非 Error 类型的抛出物', () => {
    for (const thrown of [undefined, null, '字符串错误', 42, { weird: true }]) {
      const normalized = normalizeError(thrown);
      expect(normalized.code).toBe('INTERNAL');
      expect(normalized.message).toBe('服务器内部错误');
    }
  });

  it('错误实例的 name 与子类一致，便于日志区分', () => {
    expect(new ParseError().name).toBe('ParseError');
    expect(new ConfigError().name).toBe('ConfigError');
  });
});
