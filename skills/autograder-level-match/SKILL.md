---
name: autograder-level-match
description: 依据已核验的证据 JSON 与评分细则的档位描述，把单个评分点归入 L1–L4 中的某一档，并给出阻断项与待人工标记。只输出单点评级，不输出总分。适用于评分标准已显性化、需要逐评分点定档的场景。
license: MIT
disable: false
---

# AutoGrader 等级匹配

## 这个 Skill 做什么

拿到**一组已经核验过的事实**（`autograder-evidence-extract` 的输出）与该评分点的档位描述，把这个评分点归入某一档。

它是主链路的第二段。**它只做两件事**：读完事实、做出这一个评分点的判断。

## 边界：只出档位，不出分数

| 本 Skill 负责 | 本 Skill 不负责 |
|---|---|
| 单个评分点的档位判定（L1–L4） | 总分合成 —— 由程序按显式权重计算 |
| 说明哪些 required 要求未满足导致封顶 | 及格线附近的判定 —— 必须人工 |
| 标记 `needs_human` 与原因 | 抄袭 / 雷同的最终定性 —— 必须人工 |
| 列出被阻断的更高档位及阻断原因 | 定性判断（创新性、表达质量）—— 必须人工 |

**为什么坚持不输出总分**：总分一旦由模型生成，就失去了可复现性与可追溯性。同样的输入可能得到不同的总分，教师无法解释"这 76.5 分怎么来的"，申诉时也无从复核。总分必须是 `权重 × 档位系数` 的确定性函数。

## 何时使用

- 证据 JSON 已就绪，需要对单个评分点定档
- 需要向教师解释「为什么不是更高档」
- 需要识别哪些评分点必须转人工

## 何时不要使用

- 证据尚未核验（引文未回查）→ 先跑 `autograder-evidence-extract`
- 评分点是 `judgment` 类型（创新性、表达质量）→ 本 Skill 不适用，直接转人工
- 需要总分 → 交给算分引擎

## 输入契约

| 字段 | 必填 | 说明 |
|---|---|---|
| `criterion_id` | ✅ | 评分点标识 |
| `criterion_name` | ✅ | 评分点名称 |
| `levels` | ✅ | 档位描述数组，含 `level` 与 `score_ratio` 与 `descriptor` |
| `cap_level_when_required_missing` | ⬜ | 封顶档位，默认 `L2` |
| `evidence` | ✅ | 该评分点的证据 JSON（`autograder-evidence-extract` 的输出） |

## 输出契约

```json
{
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
  "prompt_version": "b3-v1"
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `matched_level` | `L4` / `L3` / `L2` / `L1` |
| `evidence_refs` | 支撑本档位的 `quote_id` 列表。**为空说明没有证据支撑，本项必须 `needs_human`** |
| `missing_refs` | 未满足的 `req_id` 列表 |
| `rule_applied` | 命中的规则名；无规则命中时为 `null` |
| `alternatives` | 被阻断的更高档位及阻断原因。用于向教师解释 |
| `needs_human` | `true` 时该点**不进入总分**，UI 显示为「待人工判定」 |
| `human_reasons` | 见下方枚举 |

### `human_reasons` 枚举闭集

| 值 | 触发条件 |
|---|---|
| `required_evidence_missing` | required 证据未满足且封顶规则不足以覆盖 |
| `unresolved_conflict` | 存在未解决的 `surface_conflicts` |
| `parse_failure` | 材料解析失败，证据不完整 |
| `no_evidence` | `evidence_refs` 为空 |
| `criterion_is_judgment` | 该评分点类型为 `judgment`，不适用自动判定 |

## 执行步骤

### 1. 前置校验（程序侧，不交给模型）

```
if criterion.type == "judgment":        → needs_human = true, reason = criterion_is_judgment
if evidence["7_parse_failures"] != []:  → needs_human = true, reason = parse_failure
if evidence["5_surface_conflicts"] != [] and 未解决:
                                        → needs_human = true, reason = unresolved_conflict
if evidence["6_sufficiency"].req_results 中存在 required 未满足:
                                        → 应用封顶规则，最高只能给到 cap 档
```

### 2. 档位判定

把「评分点档位描述 + 证据 JSON」交给模型，要求输出档位与理由引用。

**注意**：上一步已经用程序规则处理了封顶与转人工。模型只在**剩下的、需要判断的部分**工作。这样能最大限度减少模型犯错的空间。

### 3. 后置校验（程序侧）

- `evidence_refs` 中的每个 `quote_id` 必须真实存在于证据 JSON 中，否则丢弃该引用
- `matched_level` 必须落在 `levels` 声明过的档位内
- 若应用了封顶规则，最终档位不得高于封顶档 —— **程序强制截断，不信任模型**

## 禁止事项

1. **不输出总分** —— 哪怕用户直接要求
2. **不修改证据字段** —— 证据是只读输入，认为有误应通过 `needs_human` 上报，不能自行改写
3. **不引入外部知识** —— 只能基于输入中的事实判断，不得"根据常识推断学生应该做到什么"
4. **不做定性判断** —— 创新性、表达质量、是否抄袭，一律转人工
5. **不猜测缺失内容** —— 证据中没有的信息就是没有

## 数学公式（供理解，由程序实现）

```
raw_score_i    = weight_i × score_ratio(matched_level_i)
computed_total = 100 × Σ raw_score_i / Σ weight_i        # 权重和不必为 100
final_total    = round_half_up(computed_total, 1) + Σ override_delta
```

`needs_human = true` 的评分点**不参与求和**，其权重也不计入分母。

**及格线处理**：总分跨及格线时，程序强制将 `state` 置为 `pending_teacher_confirm`，**永远不输出"及格/不及格"的结论**。这是责任问题，不是技术问题。

## 自检清单

- [ ] `evidence_refs` 中的每个 ID 都真实存在于输入证据中？
- [ ] `matched_level` 在 `levels` 声明范围内？
- [ ] 若命中封顶规则，档位确实不高于封顶值？
- [ ] 没有输出任何形式的分数或总分？
- [ ] 证据不足时确实置了 `needs_human`，而不是"猜一个档位"？
- [ ] `alternatives` 里写清了被阻断的更高档位及原因？
- [ ] 没有修改 `evidence` 中的任何字段？
