/**
 * 配置校验单元测试。
 *
 * 这些用例守的是「快速失败」这条线：配置错了必须在第一次请求就炸，
 * 而不是等服务跑起来之后在某个评分点上报 undefined。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getConfig, resetConfigCache, type Bindings } from '../src/config';
import { ConfigError } from '../src/errors';

const VALID = {
  DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash',
  DEEPSEEK_TIMEOUT_MS: '120000',
  DEEPSEEK_MAX_RETRIES: '3',
  ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:8787',
  RATE_LIMIT_GRADE_PER_MIN: '10',
  RATE_LIMIT_UPLOAD_PER_MIN: '20',
  MAX_UPLOAD_BYTES: '20971520',
  QUOTE_VERIFY_MIN_SIMILARITY: '0.9',
  EVIDENCE_EXTRACT_CONCURRENCY: '5',
  LOG_LEVEL: 'info',
  DEMO_FALLBACK_ENABLED: 'false',
};

function makeEnv(overrides: Record<string, string> = {}): Bindings {
  return { ...VALID, ...overrides } as unknown as Bindings;
}

describe('配置校验', () => {
  beforeEach(() => resetConfigCache());

  it('合法配置解析通过，并完成类型转换', () => {
    const cfg = getConfig(makeEnv());
    expect(cfg.DEEPSEEK_TIMEOUT_MS).toBe(120000);
    expect(cfg.DEEPSEEK_MAX_RETRIES).toBe(3);
    expect(cfg.DEMO_FALLBACK_ENABLED).toBe(false);
    expect(cfg.QUOTE_VERIFY_MIN_SIMILARITY).toBe(0.9);
  });

  it('ALLOWED_ORIGINS 按逗号拆分并去空格', () => {
    const cfg = getConfig(makeEnv());
    expect(cfg.ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8787']);
  });

  it('布尔字符串 true / 1 / yes / on 都识别为 true', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
      resetConfigCache();
      expect(getConfig(makeEnv({ DEMO_FALLBACK_ENABLED: v })).DEMO_FALLBACK_ENABLED).toBe(true);
    }
    resetConfigCache();
    expect(getConfig(makeEnv({ DEMO_FALLBACK_ENABLED: 'false' })).DEMO_FALLBACK_ENABLED).toBe(false);
    resetConfigCache();
    expect(getConfig(makeEnv({ DEMO_FALLBACK_ENABLED: '' })).DEMO_FALLBACK_ENABLED).toBe(false);
  });

  it('缺少 DEEPSEEK_API_KEY 时抛 ConfigError', () => {
    expect(() => getConfig(makeEnv({ DEEPSEEK_API_KEY: '' }))).toThrow(ConfigError);
  });

  it('BASE_URL 非法时抛 ConfigError', () => {
    expect(() => getConfig(makeEnv({ DEEPSEEK_BASE_URL: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('QUOTE_VERIFY_MIN_SIMILARITY 超出范围时抛 ConfigError', () => {
    expect(() => getConfig(makeEnv({ QUOTE_VERIFY_MIN_SIMILARITY: '0.1' }))).toThrow(ConfigError);
    resetConfigCache();
    expect(() => getConfig(makeEnv({ QUOTE_VERIFY_MIN_SIMILARITY: '1.5' }))).toThrow(ConfigError);
  });

  it('并发上限超过 6 时抛 ConfigError（Workers 并发出站连接为 6）', () => {
    expect(() => getConfig(makeEnv({ EVIDENCE_EXTRACT_CONCURRENCY: '10' }))).toThrow(ConfigError);
  });

  it('LOG_LEVEL 只接受四个枚举值', () => {
    resetConfigCache();
    expect(() => getConfig(makeEnv({ LOG_LEVEL: 'verbose' }))).toThrow(ConfigError);
  });

  it('错误信息不回显任何配置值', () => {
    try {
      getConfig(makeEnv({ DEEPSEEK_API_KEY: '', ALLOWED_ORIGINS: '' }));
      throw new Error('本应抛错');
    } catch (err) {
      const serialized = JSON.stringify((err as ConfigError).internal ?? {});
      expect(serialized).not.toContain('sk-test');
    }
  });

  it('校验结果被缓存，重复调用返回同一对象', () => {
    const env = makeEnv();
    expect(getConfig(env)).toBe(getConfig(env));
  });
});
