# 附录 · 数据契约与 Prompt 全文

> 本附录是《AutoGrader 技术方案》的配套材料，包含四份 JSON Schema 全文、三段 Prompt 全文、禁用词表、降级链伪代码、平台限制对照表与成本测算明细。
>
> 一切字段以本附录为准。代码实现与本附录冲突时，改代码。

---

## 目录

- [A. 数据契约](#a-数据契约)
  - [A.1 Rubric（评分细则）](#a1-rubric评分细则)
  - [A.2 EvidenceExtraction（观察层）](#a2-evidenceextraction观察层)
  - [A.3 LevelMatch（等级匹配）](#a3-levelmatch等级匹配)
  - [A.4 FinalGrade（最终评分记录）](#a4-finalgrade最终评分记录)
  - [A.5 契约的三条硬性约束](#a5-契约的三条硬性约束)
- [B. Prompt 全文](#b-prompt-全文)
  - [B.1 阶段 A：全篇章节索引](#b1-阶段-a全篇章节索引)
  - [B.2 阶段 B：分评分点证据抽取](#b2-阶段-b分评分点证据抽取)
  - [B.3 等级匹配](#b3-等级匹配)
- [C. 禁用词表](#c-禁用词表)
- [D. 非法 JSON 降级链](#d-非法-json-降级链)
- [E. 平台限制对照表](#e-平台限制对照表)
- [F. 成本测算明细](#f-成本测算明细)
- [G. 依赖清单](#g-依赖清单)

---

## A. 数据契约

### A.1 Rubric（评分细则）

```json
{
  "rubric_id": "rb_os_lab3",
  "title": "操作系统实验三 · 进程与信号",
  "course": "操作系统",
  "version": 3,
  "total_points": 100,
  "criteria": [
    {
      "criterion_id": "c1",
      "name": "实验原理说明",
      "weight": 10,
      "type": "execution",
      "evidence_requirements": [
        { "req_id": "r1", "kind": "section",     "target": "原理说明", "min_chars": 200, "required": true },
        { "req_id": "r2", "kind": "code_symbol", "target": "fork|waitpid",             "required": true }
      ],
      "levels": [
        { "level": "L4", "score_ratio": 1.0, "descriptor": "完整覆盖全部要点，无遗漏" },
        { "level": "L3", "score_ratio": 0.8, "descriptor": "覆盖主要要点，个别次要要点缺失" },
        { "level": "L2", "score_ratio": 0.5, "descriptor": "覆盖部分要点，存在明显缺失" },
        { "level": "L1", "score_ratio": 0.2, "descriptor": "近乎未涉及" }
      ],
      "cap_level_when_required_missing": "L2"
    }
  ],
  "scoring": {
    "compose": "weighted_sum",
    "round": "half_up_1",
    "pass_line": 60,
    "pass_line_requires_human": true
  }
}
```

**字段说明**

| 字段 | 说明 |
|---|---|
| `type` | `execution`（可机械化核查）或 `judgment`（必须人工）。**`judgment` 类型的评分点不进入自动流程** |
| `evidence_requirements[].kind` | `section` 按章节标题匹配；`code_symbol` 按代码符号正则匹配；`figure` 按图表编号匹配 |
| `required: true` | 未满足时触发封顶规则，见 A.5 |
| `levels[].score_ratio` | 档位系数，可按评分点自定义 |
| `pass_line_requires_human` | 恒为 `true`——程序永远不输出"及格/不及格"结论 |

---

### A.2 EvidenceExtraction（观察层）

**这是本系统的核心契约。它不含任何定性判断字段。**

```json
{
  "evidence_id": "ev_0001",
  "submission_id": "sub_001",
  "criterion_id": "c1",
  "extractor_version": "ev-v1.0",
  "prompt_version": "b2-v1",
  "model": "deepseek-flash",

  "1_searched_materials": [
    {
      "material_id": "m1",
      "source_type": "report_text",
      "range": "p.3-4",
      "query": "原理说明"
    }
  ],

  "2_found_quotes": [
    {
      "quote_id": "q1",
      "material_id": "m1",
      "text": "……原文逐字摘录，不得改写……",
      "location": {
        "page": 3,
        "anchor": "§2.1 第2段",
        "char_start": 1024,
        "char_end": 1180
      },
      "verified": "exact"
    }
  ],

  "3_locations_index": [
    { "material_id": "m1", "page": 3, "anchor": "§2.1" }
  ],

  "4_not_found": [
    {
      "expectation_id": "r2",
      "expected": "对 waitpid 返回值的处理说明",
      "searched_scope": ["report_text", "appendix"],
      "status": "not_found"
    }
  ],

  "5_surface_conflicts": [
    {
      "conflict_id": "x1",
      "nature": "factual_mismatch",
      "claim": "正文称使用多进程并回收子进程",
      "claim_location": { "page": 2, "anchor": "§2.3" },
      "observed": "代码清单中 fork 仅出现 1 次，无 wait/waitpid 调用",
      "observed_location": { "page": 6, "anchor": "list.1 L12-20" }
    }
  ],

  "6_sufficiency": {
    "status": "insufficient",
    "req_results": [
      { "req_id": "r1", "met": true },
      { "req_id": "r2", "met": false }
    ],
    "matched_by": "program_rule",
    "rule_version": "suf-v1"
  },

  "7_parse_failures": [
    {
      "stage": "pdf_text_extraction",
      "code": "EMPTY_TEXT_LAYER",
      "material_id": "m2",
      "page_range": "p.8-9",
      "recoverable": true
    }
  ],

  "runtime_probe": { "status": "not_executed", "sandbox_ref": null },
  "extracted_at": "2026-09-18T04:10:00Z"
}
```

**七个字段与设计要求的对应关系**

| # | 字段 | 对应需求 | 由谁产出 |
|---|---|---|---|
| 1 | `1_searched_materials` | 搜索过哪些材料 | 模型（阶段 A 的索引 + 阶段 B 的检索声明） |
| 2 | `2_found_quotes` | 找到了哪些原文 | 模型 |
| 3 | `3_locations_index` | 原文位置 | 模型给锚点，**字符偏移由程序回填** |
| 4 | `4_not_found` | 没找到什么 | 模型 |
| 5 | `5_surface_conflicts` | 是否出现表面冲突 | 模型 |
| 6 | `6_sufficiency` | 材料是否足以判断 | **程序**（按 `evidence_requirements` 比对，不让模型自由判断） |
| 7 | `7_parse_failures` | 解析是否失败 | 程序（解析层） |

#### 被刻意排除的字段

以下字段**禁止出现在本契约中**：`score`、`grade`、`level`、`quality`、`comment`、`is_good`、`is_complete`、`should_*`。

评审若在 PR 中看到这些字段，一律要求移除。

#### `5_surface_conflicts.nature` 的枚举闭集

只允许三个值：

| 值 | 含义 |
|---|---|
| `factual_mismatch` | 陈述与代码/数据/图表不一致 |
| `numeric_mismatch` | 数值不一致（如报告写 3.2s，数据表为 5.1s） |
| `internal_inconsistency` | 报告内部前后不一致 |

**明确禁止**：`plagiarism`、`cheating`、`dishonest`、`suspicious`。相似度高不等于抄袭——同模板、同教材范例、教师发放的 starter code、同组同学讨论都会产生高相似度。定性需要解释规则，而规则是人定的。

---

### A.3 LevelMatch（等级匹配）

```json
{
  "match_id": "lm_0001",
  "submission_id": "sub_001",
  "criterion_id": "c1",
  "matched_level": "L2",
  "evidence_refs": ["q1"],
  "missing_refs": ["r2"],
  "rule_applied": "cap_level_when_required_missing",
  "alternatives": [
    { "level": "L3", "blocked_by": "r2 未满足" }
  ],
  "needs_human": true,
  "human_reasons": ["required_evidence_missing"],
  "matched_at": "2026-09-18T04:12:00Z"
}
```

`needs_human` 为 `true` 时，该评分点**不进入总分**，UI 上显示为「待人工判定」。触发条件见 A.5。

---

### A.4 FinalGrade（最终评分记录）

```json
{
  "grade_id": "g_0001",
  "submission_id": "sub_001",
  "rubric_id": "rb_os_lab3",
  "rubric_version": 3,
  "engine_version": "calc-v1",

  "items": [
    {
      "criterion_id": "c1",
      "weight": 10,
      "level": "L2",
      "score_ratio": 0.5,
      "raw_score": 5.0,
      "source": "auto",
      "is_overridden": false
    }
  ],

  "computed_total": 76.5,
  "final_total": 78.0,
  "override_delta": 1.5,
  "has_pending_items": false,

  "state": "teacher_confirmed",
  "confirmed_by": "teacher_A",
  "confirmed_at": "2026-09-18T05:00:00Z",

  "calibration_signals": [
    {
      "criterion_id": "c1",
      "agent_level": "L2",
      "human_level": "L3",
      "reason_code": "rule_too_strict",
      "teacher_note": "该点缺失不构成降档",
      "created_at": "2026-09-18T05:00:00Z"
    }
  ]
}
```

**`state` 状态机**

```
draft → evidence_extracted → level_matched → scored
                                              ↓
                                    pending_teacher_confirm
                                              ↓
                                    teacher_confirmed  → archived
```

**`reason_code` 枚举**（改档必填，不允许自由文本作为唯一原因）

| 值 | 含义 |
|---|---|
| `rule_too_strict` | 细则过严 |
| `rule_too_loose` | 细则过松 |
| `evidence_misread` | 证据被误读 |
| `material_missing` | 材料缺失导致误判 |
| `other` | 其他（必须填 `teacher_note`） |

**校准信号只用于"建议改规则"，不自动改规则。** 规则变更必须由人确认，并写入新的 `rubric.version`，同时触发一次评测回放。

---

### A.5 契约的三条硬性约束

#### 约束一：观察层去定性化 —— 三层防线

| 层 | 机制 | 失败处理 |
|---|---|---|
| L1 Prompt | 禁用词表 + 句式模板 + 自检指令 | 无效则进入 L2 |
| L2 Schema | Zod 枚举约束，`nature` 等字段为闭集 | 校验失败即拒收 |
| L3 后置扫描 | 程序扫描输出文本中的禁用词 | **命中即拒收并重生成，最多 2 次，仍失败则置 `needs_human`** |

L3 是最后一道也是最硬的一道。**只有它把"防定性"从口头承诺变成机器约束。**

#### 约束二：`6_sufficiency` 由程序判定

不让模型自由判断"材料是否足够"。程序按 `evidence_requirements` 逐条比对，产出 `req_results`：

```
for req in criterion.evidence_requirements:
    if req.kind == "section"      → 检查对应章节是否存在且字数 >= min_chars
    if req.kind == "code_symbol"  → 在代码块中正则匹配 target
    if req.kind == "figure"       → 检查图表编号是否被引用
    req_results[req.req_id].met = <布尔>
```

这样 `insufficient` 就是一个可核验的事实陈述（"r2 未满足"），而不是"这份报告不够好"。

#### 约束三：位置以程序计算为准

模型给出的 `char_start` / `char_end` **一律不信任**。程序在解析文本中对 `found_quotes[].text` 做匹配：

| 匹配结果 | 处理 |
|---|---|
| 精确子串命中 | 回填真实偏移，`verified = "exact"` |
| 归一化相似度 ≥ `QUOTE_VERIFY_MIN_SIMILARITY` | 回填偏移，`verified = "fuzzy"` |
| 未命中 | **丢弃该 quote**，写入 `7_parse_failures: QUOTE_NOT_VERIFIABLE` |

---

## B. Prompt 全文

> 版本号写在 prompt 头部，与 `prompt_version` 字段对应。修改 prompt 必须同步升版本号并触发评测回放。

### B.1 阶段 A：全篇章节索引

**目的**：先建立全篇地图，让阶段 B 的"未找到"有全局依据，避免因切块而误判缺失。

```
prompt_version: b1-v1
temperature: 0

你是文档结构标注员。你的任务是给出一份实验报告的章节与材料清单。
你不做任何评价。

【输出要求】
1. 逐条列出报告中的章节标题、所属页码、起止字符位置。
2. 列出所有代码清单、图表的位置。
3. 若某部分无法提取文本，在 parse_failures 中如实记录，不要猜测内容。

【绝对禁止】
不要出现任何评价性词语（好/差/完整/缺失/不合格/充分/不足等）。
你只回答"有什么、在哪里"，不回答"怎么样"。

请以 json 输出，字段与下面示例严格一致：

{
  "sections": [
    { "title": "2.1 原理说明", "page": 3, "char_start": 1024, "char_end": 2140,
      "level": 2, "approx_chars": 1116 }
  ],
  "code_blocks": [
    { "id": "list.1", "page": 6, "lang": "c", "lines": 42, "char_start": 5100, "char_end": 6300 }
  ],
  "figures": [
    { "id": "fig.2", "page": 5, "caption": "进程状态转换图" }
  ],
  "parse_failures": [
    { "stage": "pdf_text_extraction", "page_range": "p.8-9",
      "code": "EMPTY_TEXT_LAYER", "recoverable": true }
  ]
}

【输入】
材料 m1（report_text，解析后全文）：
"""
{{parsed_text}}
"""
```

---

### B.2 阶段 B：分评分点证据抽取

**目的**：为每个评分点抽取可核验证据。按评分点分组（每组 4–6 条）调用，每次注入**全篇章节索引 + 相关切片**。

```
prompt_version: b2-v1
temperature: 0
response_format: { "type": "json_object" }

你是证据抽取员。你的唯一职责是记录"原文里有什么、在哪里、缺什么"。
你不是评分员，不得给出任何评价。

【绝对禁止】输出以下类型词汇及其近义词：
好、差、优秀、良好、不合格、敷衍、认真、完整、缺失、创新、合理、充分、不足、
抄袭、疑似、显然、应该是、建议、值得、问题。

【自检规则】
写完每一条之后问自己：如果把这句删掉，读者还能按位置去原文核对吗？
如果不能，说明这句话是判断而非观察，必须删除。

【允许的句式模板】
- "在 <位置> 找到原文：<逐字摘录>"
- "在 <范围> 内检索 <关键词>，未找到匹配"
- "正文 <位置A> 陈述 X；代码 <位置B> 为 Y；两者不一致"
- "该评分点要求的 <req_id> 未获得匹配"

【位置规范】
每一条 found_quotes 必须给出 material_id + page + anchor。
无法给出位置的内容一律不要输出。

【冲突处理】
只描述"哪个事实与哪个事实不一致"。
不解释原因、不推测动机、不使用任何涉及学术诚信的词汇。
nature 字段只能取以下三个值之一：
factual_mismatch | numeric_mismatch | internal_inconsistency

【输入】

评分点：
- criterion_id: {{criterion_id}}
- 名称: {{criterion_name}}
- 所需证据清单: {{evidence_requirements_json}}

全篇章节索引（用于确定检索范围）：
{{section_index_json}}

相关材料切片：
{{chunks}}

【输出】请以 json 输出，字段与下面示例严格一致：

{
  "1_searched_materials": [
    { "material_id": "m1", "source_type": "report_text", "range": "p.3-4", "query": "原理说明" }
  ],
  "2_found_quotes": [
    { "quote_id": "q1", "material_id": "m1", "text": "……逐字摘录……",
      "location": { "page": 3, "anchor": "§2.1 第2段" } }
  ],
  "3_locations_index": [
    { "material_id": "m1", "page": 3, "anchor": "§2.1" }
  ],
  "4_not_found": [
    { "expectation_id": "r2", "expected": "对 waitpid 返回值的处理说明",
      "searched_scope": ["report_text", "appendix"], "status": "not_found" }
  ],
  "5_surface_conflicts": [
    { "conflict_id": "x1", "nature": "factual_mismatch",
      "claim": "……", "claim_location": { "page": 2, "anchor": "§2.3" },
      "observed": "……", "observed_location": { "page": 6, "anchor": "list.1 L12-20" } }
  ]
}

注意：不要输出 6_sufficiency 与 7_parse_failures，这两个字段由程序生成。
```

---

### B.3 等级匹配

```
prompt_version: b3-v1
temperature: 0
response_format: { "type": "json_object" }

你是评分档位匹配员。你拿到的是一组**已核验的事实**（证据 JSON），
以及该评分点的档位描述。你的任务是把这个评分点归入某一档。

【你必须遵守】
1. 只能基于输入中已有的事实做判断，不得引入任何外部知识。
2. 若证据中标明某个 required 要求未满足，最高只能给到细则中
   cap_level_when_required_missing 指定的档位。
3. 若证据中存在未解决的 surface_conflicts，把 needs_human 设为 true，
   并说明是哪一条冲突导致的。
4. 你只输出**单个评分点**的档位，绝不输出总分。

【输入】

评分点：{{criterion_name}}
档位描述：
{{levels_json}}
封顶规则：{{cap_rule}}

证据 JSON：
{{evidence_json}}

【输出】请以 json 输出：

{
  "matched_level": "L2",
  "evidence_refs": ["q1"],
  "missing_refs": ["r2"],
  "rule_applied": "cap_level_when_required_missing",
  "alternatives": [ { "level": "L3", "blocked_by": "r2 未满足" } ],
  "needs_human": true,
  "human_reasons": ["required_evidence_missing"]
}
```

---

## C. 禁用词表

程序后置扫描使用。命中即拒收并重生成。

### C.1 硬禁用（出现在观察层即拒收）

```
好 差 优秀 良好 合格 不合格 及格 不及格 敷衍 认真 仔细 粗糙
完整 完备 缺失 遗漏（除"未找到"语境） 创新 新颖 合理 不合理
充分 不足 丰富 单薄 深入 浅显 规范 不规范 清晰 含糊
抄袭 剽窃 雷同 疑似 显然 应该 建议 值得 问题 缺陷 错误（除"数值不一致"语境）
```

### C.2 条件禁用（需人工复核语境）

| 词 | 允许的语境 | 禁止的语境 |
|---|---|---|
| 缺失 | `4_not_found` 中作为检索结果 | `2_found_quotes` 中作为评价 |
| 错误 | `5_surface_conflicts` 中描述数值不一致 | 任何评价性表述 |
| 不一致 | `5_surface_conflicts` 中描述事实冲突 | 描述"写得不好" |

### C.3 扫描实现建议

```ts
const HARD_BANNED = /(好|差|优秀|良好|不合格|敷衍|认真|完整|缺失|创新|合理|充分|不足|抄袭|疑似|显然|应该|建议|值得|问题)/;

function assertNoJudgement(evidence: EvidenceExtraction) {
  const haystack = [
    ...evidence["2_found_quotes"].map(q => q.text),
    ...evidence["4_not_found"].map(n => n.expected),
    ...evidence["5_surface_conflicts"].flatMap(c => [c.claim, c.observed]),
  ].join("\n");

  const hit = haystack.match(HARD_BANNED);
  if (hit) throw new JudgementLeakError(hit[0]);
}
```

> 注：正则只是第一道筛选。「缺失/错误」这类词有合法语境，实际实现应结合字段位置判断，不要无差别拒收。

---

## D. 非法 JSON 降级链

DeepSeek 的 JSON Output 模式有已知的偶发空 `content` 问题，必须显式处理。

```
function parseModelJson(raw: string): unknown {
  // 1. 直接解析
  try { return JSON.parse(raw); } catch {}

  // 2. 抽取 ```json 围栏内的内容
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }

  // 3. 机械修复：去 BOM、去尾逗号、补右括号
  const repaired = repair(raw);
  try { return JSON.parse(repaired); } catch {}

  // 4. 交给调用方重试（最多 1 次，temperature=0，追加"只输出 JSON"）
  throw new UnparsableJsonError(raw);
}
```

**完整重试策略**

| 情况 | 处理 |
|---|---|
| 空 `content` | 视为可重试失败，重试 1 次 |
| 解析失败 | 走上面 4 步；仍失败则重试 1 次 |
| Zod 校验失败，缺可选数组 | 填空数组，继续 |
| Zod 校验失败，缺 `found_quotes[].location` | **致命**，触发重试 |
| 连续 2 次失败 | 该评分点标记 `needs_human`，写入 `7_parse_failures`，**不静默填充** |
| HTTP 429 / 5xx | 指数退避重试 3 次（0.5s / 2s / 8s） |
| HTTP 4xx（非 429） | 不重试，直接失败并记录 |

---

## E. 平台限制对照表

来源口径：`developers.cloudflare.com/workers/platform/limits/`、`/queues/platform/limits/`、`/durable-objects/platform/pricing/`、`/workflows/`（2026-08 文档）。**实施前请复核一次。**

| 项 | Free | Paid | 对本项目的影响 |
|---|---|---|---|
| CPU 时间 / 请求 | **10 ms** | 默认 30 s，可配置至 5 min | **Free 不够用**，一次 PDF 抽取 + JSON 校验必然超过 10 ms |
| 内存 / isolate | 128 MB | 128 MB | 单份报告足够 |
| 请求体上限 | 100 MB | 100 MB | 报告上传毫无压力，不必分片 |
| 请求数 | 100,000/天 | 无上限 | 演示规模完全够 |
| 并发出站连接 | 6 | 6 | 抽取并发组数设为 5 正好卡在限制内 |
| 持久文件系统 | 无 | 无 | 解析产物必须落 R2 |

**关键事实**：官方文档明示 `fetch()` 的等待时间**不计入 CPU 时间**。这是整个架构能成立的前提——调用 DeepSeek 等二十秒不会撞限制。

**入站请求的 wall time 无硬上限**，但只要客户端断连，所有关联任务立即取消；`ctx.waitUntil()` 只额外保活 30 秒。因此：**30 秒内完不成的批量任务绝不能放在单次 HTTP 请求里。**

**Workflows**：`step.do()` 单步 wall time 无上限、状态持久化、失败自动重试、`step.waitForEvent()` 可挂起等待教师确认。批量评阅 + 人工确认的正确落点。

**`nodejs_compat`**：`compatibility_date >= 2026-08-04` 时默认启用。已支持 `Buffer`、`zlib`、`crypto`、`stream`、`path`、`util`、`timers`。**不可用**：`child_process`、`worker_threads`、`node:sqlite`、`vm`、`http2`。**无 DOM / 无 Canvas** —— 这是浏览器端 PDF 库（如 `pdfjs-dist`）在 Worker 里跑不起来的根因，必须用 `unpdf`。

---

## F. 成本测算明细

### F.1 Token 估算（单份 10 页报告、20 条评分点）

| 项 | 估算 |
|---|---|
| 报告正文（约 6,000 汉字，含表格与代码） | ≈ 6,000 tokens |
| 评分细则（20 条 × 约 80 字） | ≈ 1,100 tokens |
| Prompt 模板 + JSON 示例（可缓存命中） | ≈ 900 tokens |
| 阶段 A 调用（1 次） | in ≈ 6,500 / out ≈ 600 |
| 阶段 B 调用（5 组，每组注入章节索引 + 切片 ≈ 1,200） | in ≈ 5 × 1,700 = 8,500 / out ≈ 5 × 1,100 = 5,500 |
| 等级匹配（1 次） | in ≈ 4,000 / out ≈ 1,000 |
| **合计** | **in ≈ 19,000 / out ≈ 7,100** |

### F.2 单价与总成本

以 `deepseek-flash` 官方公开价（per 1M tokens）为口径，**实施时请以控制台实时价格为准**：

| 项 | 峰时 | 错峰 |
|---|---|---|
| 缓存未命中输入 | $0.3 / M | $0.15 / M |
| 输出 | $1.2 / M | $0.6 / M |

| 规模 | 峰时成本 | 错峰成本 |
|---|---|---|
| 单份报告 | ≈ $0.014（约 ¥0.10） | ≈ $0.007（约 ¥0.05） |
| 30 份（演示规模） | ≈ $0.42（约 ¥3.0） | ≈ ¥1.5 |
| 加上 Workers Paid | — | $5/月（约 ¥36） |
| **演示月总成本** | | **< ¥40** |

> **重要提醒**：峰时为 UTC 01:00–04:00 与 06:00–10:00（周一至周五），换算北京时间是 **09:00–12:00 与 14:00–18:00** —— 正是比赛演示与评审体验的时段。**按峰时价做预算，不要指望错峰折扣。**

**结论：成本不是瓶颈，时间是。** 一份报告端到端约 2–4 分钟（主要是 LLM 往返），这才是需要优化的对象。

---

## G. 依赖清单

引入前已核对，无重复能力依赖。安装命令：

```bash
npm install hono zod unpdf mammoth
npm install -D wrangler typescript @cloudflare/workers-types vitest
```

| 包 | 用途 | 备注 |
|---|---|---|
| `hono` | Worker 路由框架 | 轻量，无 Node 依赖，Workers 生态首选 |
| `zod` | 输入输出双向校验 | 契约先行，校验失败即拒收 |
| `unpdf` | PDF 文本抽取 | PDF.js 的 serverless 构建，官方支持 Workers。**不要用 `pdfjs-dist`** |
| `mammoth` | DOCX 转 HTML/纯文本 | 保留标题层级，天然可作 anchor |
| `wrangler` | 本地开发与部署 | `compatibility_date >= 2026-08-04` |
| `vitest` | 单元测试 | 算分引擎与校验逻辑必须覆盖 |

**平台内置、无需额外依赖**：

| 能力 | 用法 |
|---|---|
| Workers AI 文档转换 | `env.AI.toMarkdown()`，处理扫描件与无文本层 PDF |
| R2 | 原始文件与解析产物 |
| D1 | 结构化记录 |
| Workflows | 批量评阅编排 |

**已知不支持**：`.doc` 旧格式（`toMarkdown` 不支持），上传时前置校验扩展名并提示另存为 `.docx`。

---

*本附录随技术方案一同维护。字段变更属破坏性变更，必须升版本号并触发评测回放。*
