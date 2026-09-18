"""线上冒烟测试：验证已部署实例的主链路是否可用。

    python scripts/verify-online.py
    AUTOGRADER_URL=https://your-worker.workers.dev python scripts/verify-online.py

它做三件事：
  1. 建一份评分细则（内容取自 fixtures/sample-rubric.json）
  2. 对 fixtures/sample-report.md 跑一次完整评阅
  3. 打印分数、逐分解释、处置原因

**期望结果**（示例报告里故意埋了两处缺陷：正文声称「父进程会回收全部子进程」
但代码里没有 wait，且完全没有信号处理）：

    c1 实验原理说明        自动定级
    c2 代码实现与功能正确性  待人工 —— 存在未解决的表面冲突 + 必需证据未满足
    c3 实验结果与数据        自动定级
    c4 问题分析与改进        自动定级

若 c2 没有转人工，说明「表面冲突检测」失效了 —— 那是这个系统的核心价值之一，
值得优先排查。若四项全部转人工，常见原因是 prompt 里的冲突归属约束被弱化
（模型会把别的评分点的缺陷也报成本项的冲突）。

注意：每次运行会新建一份细则（版本号自增），并消耗 4 个评分点 × 2 次模型调用。
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("AUTOGRADER_URL", "https://autograder.yukii0403.workers.dev").rstrip("/")
VID = "11111111-2222-3333-4444-555555555555"

REASON = {
    "required_evidence_missing": "必需证据未满足",
    "unresolved_conflict": "存在未解决的表面冲突",
    "parse_failure": "材料解析失败",
    "no_evidence": "没有可核对的依据",
    "criterion_is_judgment": "属于定性判断",
    "level_undefined": "档位未在细则中定义",
}


def call(path, payload=None, timeout=300):
    """用 curl 调用接口。

    不用 urllib：Cloudflare 的浏览器完整性检查会把 `Python-urllib/x.y` 判为机器人
    并返回 403 error code 1010（curl 的 UA 能通过）。那是平台侧策略，
    不是应用代码的问题 —— 浏览器访问不受影响。
    """
    cmd = [
        "curl", "-s", "-m", str(timeout),
        "-H", "X-Visitor-Id: " + VID,
        "-w", "\n%{http_code}",
    ]
    if payload is not None:
        cmd += [
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "--data-binary", "@-",
            BASE + path,
        ]
        stdin = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    else:
        cmd += [BASE + path]
        stdin = None

    started = time.time()
    proc = subprocess.run(cmd, input=stdin, capture_output=True, timeout=timeout + 20)
    elapsed = time.time() - started

    out = proc.stdout.decode("utf-8", "replace")
    body, _, code = out.rpartition("\n")
    try:
        parsed = json.loads(body)
    except Exception:
        parsed = {"raw": body[:600]}

    try:
        status = int(code.strip())
    except Exception:
        status = 0
    if status == 0 and proc.stderr:
        parsed = {"curlError": proc.stderr.decode("utf-8", "replace")[:400]}

    return status, parsed, elapsed


def main():
    print("目标：%s" % BASE)
    print()
    print("=" * 66)
    print("① 建评分细则")
    print("=" * 66)

    with open("fixtures/sample-rubric.json", encoding="utf-8") as f:
        rubric_in = json.load(f)

    status, res, elapsed = call("/api/rubrics", rubric_in)
    print("HTTP %s  (%.1fs)" % (status, elapsed))
    if status != 201:
        print(json.dumps(res, ensure_ascii=False, indent=2)[:900])
        return 1

    rubric_id = res["rubric"]["rubric_id"]
    print("rubric_id = %s   version = %s   criteria = %d"
          % (rubric_id, res["rubric"]["version"], len(res["rubric"]["criteria"])))

    print()
    print("=" * 66)
    print("② 完整评阅（抽取 + 匹配 + 算分）")
    print("=" * 66)

    with open("fixtures/sample-report.md", encoding="utf-8") as f:
        text = f.read()

    status, out, elapsed = call(
        "/api/grade", {"rubricId": rubric_id, "materialId": "m1", "text": text}
    )
    print("HTTP %s  (%.1fs)" % (status, elapsed))
    if status != 200:
        print(json.dumps(out, ensure_ascii=False, indent=2)[:1600])
        return 1

    grade = out["grade"]
    stats = out["stats"]

    print()
    print("--- 分数 ---")
    print("computed_total = %s   final_total = %s   state = %s"
          % (grade["computed_total"], grade["final_total"], grade["state"]))

    print()
    print("--- 统计 ---")
    print("评分点 %s 个 | 自动 %s | 待人工 %s | 引文保留 %s / 丢弃 %s | 用时 %s ms"
          % (stats["criteriaCount"], stats["autoCount"], stats["pendingCount"],
             stats["quoteKept"], stats["quoteDropped"], stats["durationMs"]))

    print()
    print("--- 逐分解释 ---")
    for row in out["explain"]:
        ratio = "-" if row["scoreRatio"] is None else row["scoreRatio"]
        print("[%s] %-22s w=%-4s %-6s ratio=%-5s raw=%-6s %s"
              % (row["criterionId"], row["criterionName"], row["weight"],
                 row["level"] or "待人工", ratio, row["rawScore"], row["source"]))
        for adj in row["adjustments"]:
            print("     程序干预：%s" % adj)

    print()
    print("--- 处置与原因 ---")
    for d in out["dispositions"]:
        reasons = "、".join(REASON.get(r, r) for r in d["reasons"]) or "-"
        print("[%s] %-22s %-8s %s" % (d["criterionId"], d["criterionName"], d["status"], reasons))
        if d.get("detail"):
            print("     %s" % d["detail"])

    print()
    print("--- 提示 ---")
    print(out["notice"])

    # 退出码语义：让这个脚本能直接用在 CI 里
    #   0  正常
    #   2  全部评分点都转人工（通常是 prompt 或规则出了问题，需要人看）
    if stats["autoCount"] == 0:
        print()
        print("⚠️ 没有任何评分点被自动定级 —— 请检查 prompt 与程序规则。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
