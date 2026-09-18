---
name: autograder-evidence-extract
description: 从学生实验报告中按评分点抽取可核验证据，输出七字段观察层 JSON（搜索范围 / 原文摘录 / 精确位置 / 缺失项 / 表面冲突 / 证据充分性 / 解析失败），全程不做任何评价。当需要"定位原文位置"而不是"打分"时使用。适用于计算机专业实验报告的自动评阅前置环节。
license: MIT
disable: false
---

# AutoGrader 证据抽取（观察层）

## 这个 Skill 做什么

给定一份已解析的学生实验报告，以及若干条评分点（含所需证据清单），逐评分点抽取**只含事实**的证据，输出结构化 JSON。

它是 AutoGrader 主链路的第一段。下游的等级匹配与算分都依赖它的输出。

## 核心原则：只观察，不判断

> **「没找到」是事实，「不合格」是判断。**

这是整个 Skill 唯一的、不可妥协的约束。违反它，下游所有结果都失去可信度。

| ✅ 允许 | ❌ 禁止 |
|---|---|
| 在 §2.1 找到原文：「……」 | 原理说明写得完整 |
| 在 p.3-4 内检索 waitpid，未找到匹配 | 缺少对 waitpid 的处理 |
| 正文 p.2 陈述使用多进程；代码 p.6 仅 1 次 fork，无 wait 调用 | 正文与代码矛盾，存在造假嫌疑 |
| 评分点要求的 r2 未获得匹配 | 该评分点不合格 |

**自检规则**：写完每一条之后问自己——如果把这句删掉，读者还能按位置去原文核对吗？如果不能，说明这句是判断，必须删除。

## 何时使用

- 需要为一份实验报告提取「原文证据 + 精确位置」，供后续人工或程序核对
- 需要产出可申诉、可追溯的评分依据
- 需要批量为多份报告建立证据档案

## 何时不要使用

- 只想得到一个分数 → 用 `autograder-level-match`
- 需要定性判断（创新性、表达质量、是否抄袭）→ **本 Skill 不做，也不应做**。这类判定必须由人承担
- 文档尚未解析成结构化文本 → 先完成解析

## 输入契约

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `submission_id` | ✅ | string | 报告唯一标识 |
| `materials` | ✅ | array | 解析后的材料清单，每项含 `material_id`、`source_type`、`parsed_text` |
| `criteria` | ✅ | array | 评分点列表，每项含 `criterion_id`、`name`、`evidence_requirements` |
| `section_index` | ⬜ | object | 全篇章节索引；未提供时本 Skill 会先执行阶段 A 生成 |
| `max_chars_per_chunk` | ⬜ | number | 默认 8000 |

`evidence_requirements[].kind` 支持三种：

| kind | 匹配方式 |
|---|---|
| `section` | 按章节标题匹配，可带 `min_chars` |
| `code_symbol` | 在代码块中做正则匹配 |
| `figure` | 按图表编号匹配 |

## 输出契约

严格输出下列 7 个字段。**不得增删字段。**

```json
{
  "submission_id": "sub_001",
  "criterion_id": "c1",
  "extractor_version": "ev-v1.0",

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
      "claim": "正文称使用多进程并回收子进程", "claim_location": { "page": 2, "anchor": "§2.3" },
      "observed": "代码清单中 fork 仅出现 1 次，无 wait/waitpid 调用",
      "observed_location": { "page": 6, "anchor": "list.1 L12-20" } }
  ],
  "6_sufficiency": {
    "status": "insufficient",
    "req_results": [ { "req_id": "r1", "met": true }, { "req_id": "r2", "met": false } ],
    "matched_by": "program_rule"
  },
  "7_parse_failures": [
    { "stage": "pdf_text_extraction", "code": "EMPTY_TEXT_LAYER",
      "material_id": "m2", "page_range": "p.8-9", "recoverable": true }
  ]
}
```

### 字段责任划分

| # | 字段 | 由谁产出 |
|---|---|---|
| 1 | `1_searched_materials` | 本 Skill（阶段 A 索引 + 阶段 B 检索声明） |
| 2 | `2_found_quotes` | 本 Skill |
| 3 | `3_locations_index` | 本 Skill 给锚点，**字符偏移由程序回填** |
| 4 | `4_not_found` | 本 Skill |
| 5 | `5_surface_conflicts` | 本 Skill |
| 6 | `6_sufficiency` | **程序**（按 `evidence_requirements` 逐条比对） |
| 7 | `7_parse_failures` | **程序**（解析层） |

字段 6 和 7 **不要由模型生成**。字段 6 让模型自由判断会立刻退化成"这份报告够不够好"的判断；由程序逐条比对，它才是一个可核验的事实陈述。

## 执行步骤

### 阶段 A：建立全篇索引（每个 submission 只做一次）

产出 `sections` / `code_blocks` / `figures` / `parse_failures`。

**为什么必须先做**：后续抽取是分块进行的。如果没有全篇索引，「未找到」就只能基于局部切片判断，会把"在别处但没看到"误报成"不存在"。全篇索引是「没找到」这个结论的全局依据。

### 阶段 B：按评分点分组抽取（每 4–6 条一组）

每次调用注入：该组评分点 + **全篇章节索引** + 相关材料切片。

```
for group in chunk(criteria, 5):
    result = call_llm(B2_PROMPT, {
        criteria: group, section_index, chunks: retrieve(group)
    })
```

### 阶段 C：程序后置处理（不由模型完成）

1. 逐条 `found_quotes[].text` 回到解析文本做匹配；未命中直接丢弃
2. 回填真实 `char_start` / `char_end`
3. 扫描禁用词，命中即拒收重生成
4. 按 `evidence_requirements` 计算 `6_sufficiency`

## 禁止事项

### 禁止词表（命中即判定本 Skill 失败）

```
好 差 优秀 良好 合格 不合格 及格 不及格 敷衍 认真 仔细 粗糙
完整 完备 创新 新颖 合理 不合理 充分 不足 丰富 单薄 深入 浅显
规范 不规范 清晰 含糊 抄袭 剽窃 雷同 疑似 显然 应该 建议 值得
```

### 禁止行为

1. **不输出分数或档位** —— 哪怕用户明确要求
2. **不解释原因、不推测动机** —— 只描述"哪个事实与哪个事实不一致"
3. **不使用涉及学术诚信的词汇** —— 相似度高不等于抄袭
4. **不编造位置** —— 无法给出位置的摘录一律不输出
5. **不猜测无法解析的内容** —— 解析失败就如实记录，不要"根据上下文推断"

## 冲突字段的枚举闭集

`5_surface_conflicts[].nature` 只允许：

| 值 | 含义 |
|---|---|
| `factual_mismatch` | 陈述与代码 / 数据 / 图表不一致 |
| `numeric_mismatch` | 数值不一致 |
| `internal_inconsistency` | 报告内部前后不一致 |

**禁止**：`plagiarism`、`cheating`、`dishonest`、`suspicious`。

## 自检清单

输出前逐条核对：

- [ ] 每条 `found_quotes` 都带 `material_id` + `page` + `anchor`？
- [ ] `text` 是逐字摘录，没有改写或概括？
- [ ] 全文没有出现禁用词？
- [ ] 没有任何字段表达"好/坏/够不够"？
- [ ] `4_not_found` 的每一条都注明了检索范围？
- [ ] `5_surface_conflicts` 只描述了事实不一致，没有推测动机？
- [ ] 没有输出 `6_sufficiency` 与 `7_parse_failures`（这两个交给程序）？
- [ ] 输出是合法 JSON，且字段与契约严格一致？
