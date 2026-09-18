/**
 * 证据抽取接口。
 *
 * 本期只接受**纯文本**输入。PDF / DOCX 解析是 M2.5 的事 —— 先让核心链路
 * （文本 → 观察层 JSON）能端到端跑通，再接文档解析，避免两个不确定因素叠在一起。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { ValidationError } from '../errors';
import { rateLimit } from '../middleware/rateLimit';
import { getRubric } from '../services/rubricService';
import { extractEvidence } from '../services/evidenceService';
import type { EvidenceExtraction } from '../schema';

export const evidenceRoutes = new Hono<AppEnv>();

/** 抽取是重操作（每个评分点一次模型调用），单独限流。 */
evidenceRoutes.use(
  '/extract',
  rateLimit({ route: 'evidence.extract', perMinute: () => 10 }),
);

const ExtractBodySchema = z.object({
  rubricId: z.string().min(3).max(64),
  /** 材料标识，缺省为 m1 */
  materialId: z.string().min(1).max(64).default('m1'),
  text: z.string().min(1).max(400_000),
  /** 只跑指定的评分点，便于调试单个 prompt */
  criterionIds: z.array(z.string()).optional(),
});

evidenceRoutes.post('/extract', async (c) => {
  const config = c.get('config')!;
  const logger = c.get('logger');
  const ownerId = c.get('ownerId');

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('请求体不是合法的 JSON');
  }

  const parsed = ExtractBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('；');
    throw new ValidationError(`请求体不合法：${issues}`);
  }
  const body = parsed.data;

  const rubric = await getRubric(c.env.DB, ownerId, body.rubricId);

  const targets = rubric.criteria.filter((criterion) => {
    if (body.criterionIds && !body.criterionIds.includes(criterion.criterion_id)) return false;
    // judgment 类型不进自动流程 —— 没有可判定的依据，跑了也是浪费
    return criterion.type === 'execution';
  });

  if (targets.length === 0) {
    throw new ValidationError('没有可抽取的评分点（judgment 类型不进入自动流程）');
  }

  const startedAt = Date.now();
  const evidence: EvidenceExtraction[] = [];
  let totalKept = 0;
  let totalDropped = 0;

  // 刻意串行：并发受 Workers 并发出站连接限制（6）约束，
  // 而这里的瓶颈是模型延迟，串行能拿到更稳定的失败定位。
  for (const criterion of targets) {
    const result = await extractEvidence({
      config,
      logger,
      submissionId: `inline_${body.materialId}`,
      criterion,
      materialId: body.materialId,
      materialText: body.text,
    });
    evidence.push(result.evidence);
    totalKept += result.quotes.kept;
    totalDropped += result.quotes.dropped;
  }

  const durationMs = Date.now() - startedAt;

  logger.info('evidence.batch_done', {
    rubricId: rubric.rubric_id,
    criteriaCount: targets.length,
    quoteKept: totalKept,
    quoteDropped: totalDropped,
    durationMs,
  });

  return c.json({
    rubricId: rubric.rubric_id,
    rubricVersion: rubric.version,
    evidence,
    summary: {
      criteriaCount: targets.length,
      quoteKept: totalKept,
      quoteDropped: totalDropped,
      // 引文可定位率的在线近似值 —— 未命中的摘录被丢弃，这个比值就是保留率
      quoteKeepRate: totalKept + totalDropped > 0
        ? Math.round((totalKept / (totalKept + totalDropped)) * 1000) / 1000
        : null,
      needsHuman: evidence.filter((e) => e['7_parse_failures'].length > 0).length,
      durationMs,
    },
  });
});
