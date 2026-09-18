/**
 * AutoGrader 工作台。
 *
 * 刻意保持零依赖、零构建：这个页面的职责是验证「部署链路 + 主链路端到端」，
 * 不是做前端工程化。M5 会换成 Vite + React，但那时构建产物仍然输出到这个目录，
 * 所以现在写的东西不会白费。
 *
 * 两条必须遵守的实现约束：
 *   1. **不用内联事件处理器**（onclick="..."）—— 服务端 CSP 是 `script-src 'self'`，
 *      内联脚本与内联事件处理器都会被浏览器拦掉。全部用 addEventListener。
 *   2. **不把 API Key 放前端** —— 前端只调用同源的 /api/*，Key 始终在服务端。
 */
(function () {
  'use strict';

  var VISITOR_KEY = 'ag_visitor_id';

  // ── 游客身份 ────────────────────────────────────────────
  // 这不是身份认证，只是数据隔离。localStorage 不可用时（隐私模式）退化为内存值，
  // 页面刷新会换一个新 id —— 可接受，因为游客模式下本来就没有跨会话数据。
  var memoryVisitorId = null;

  function visitorId() {
    try {
      var existing = window.localStorage.getItem(VISITOR_KEY);
      if (existing) return existing;
      var created = newVisitorId();
      window.localStorage.setItem(VISITOR_KEY, created);
      return created;
    } catch (err) {
      if (!memoryVisitorId) memoryVisitorId = newVisitorId();
      return memoryVisitorId;
    }
  }

  function newVisitorId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // 极旧浏览器的兜底，只用于数据隔离，不用于安全用途
    return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ── 示例报告 ────────────────────────────────────────────
  // 用数组 join 而不是模板字符串：报告正文里含 markdown 代码围栏（三个反引号），
  // 在模板字符串里需要转义，可读性差且容易出错。
  var SAMPLE_REPORT = [
    '# 操作系统实验三：进程与信号',
    '',
    '## 1 实验目的',
    '',
    '掌握进程创建与父子进程的协作方式，理解信号机制在进程间通信中的作用，',
    '并能够观察进程树在程序运行期间的变化。',
    '',
    '## 2 原理说明',
    '',
    '进程是操作系统资源分配的基本单位。Linux 通过 fork 系统调用创建新进程，',
    '调用一次返回两次：父进程中返回子进程的 PID，子进程中返回 0。因此程序可以通过',
    '返回值区分当前运行在父进程还是子进程，并据此执行不同的代码分支。子进程会继承',
    '父进程的地址空间副本、文件描述符表与信号处理设置，但拥有独立的 PID 与资源计数。',
    '',
    '父进程必须对已终止的子进程调用 wait 或 waitpid，否则子进程的退出状态会一直',
    '保留在内核中，形成僵尸进程，长期运行会耗尽进程表项。信号是内核向进程投递的',
    '异步通知，进程可以通过 sigaction 注册处理函数，在收到信号时中断当前执行流并',
    '转入处理逻辑。SIGINT 与 SIGTERM 常用于要求进程优雅退出，SIGCHLD 则在子进程',
    '状态改变时通知父进程，是回收子进程的常用触发点。',
    '',
    '## 3 实现过程',
    '',
    '程序主体由一次 fork 构成。父进程打印自身 PID 与子进程 PID，随后继续执行',
    '主流程；子进程打印提示信息后直接返回。父进程在退出前会回收全部子进程，',
    '因此不会残留僵尸进程。',
    '',
    '## 4 代码实现',
    '',
    '```c',
    '#include <stdio.h>',
    '#include <unistd.h>',
    '#include <sys/types.h>',
    '',
    'int main(void) {',
    '    pid_t pid = fork();',
    '    if (pid < 0) {',
    '        perror("fork failed");',
    '        return 1;',
    '    }',
    '    if (pid == 0) {',
    '        printf("child: pid=%d\\n", (int)getpid());',
    '        return 0;',
    '    }',
    '    printf("parent: pid=%d, child=%d\\n", (int)getpid(), (int)pid);',
    '    printf("parent: work finished\\n");',
    '    return 0;',
    '}',
    '```',
    '',
    '## 5 实验结果',
    '',
    '在 Ubuntu 22.04 下用 gcc 12.3 编译运行，三次执行的输出顺序一致，子进程均先于',
    '父进程完成打印。实测结果见图1。加打印后可以看到父进程与子进程的 PID 满足',
    '父子关系，说明 fork 的返回值语义与预期一致。程序正常退出，未观察到异常中断，',
    '整体行为与设计目标相符。',
    '',
    '图1 程序运行输出（父进程与子进程的 PID 对照）',
    '',
    '## 6 问题分析与改进',
    '',
    '本次实现过程较为顺利，主要时间花在确认 fork 返回值含义上。目前程序只覆盖了',
    '单次 fork 的场景，尚未涉及多子进程并发的情形；输出顺序依赖调度，重复实验时',
    '偶尔出现父进程先打印的情况。后续可以在此基础上增加子进程数量的控制，并补充',
    '对输出顺序的显式同步。',
    '',
  ].join('\n');

  // ── DOM ─────────────────────────────────────────────────
  var elRubric = document.getElementById('rubric');
  var elReport = document.getElementById('report');
  var elRun = document.getElementById('run');
  var elSample = document.getElementById('load-sample');
  var elStatus = document.getElementById('status');
  var elResult = document.getElementById('result');
  var elMeta = document.getElementById('result-meta');
  var elFinalTotal = document.getElementById('final-total');
  var elScoreSub = document.getElementById('score-sub');
  var elAutoPending = document.getElementById('auto-pending');
  var elQuoteRate = document.getElementById('quote-rate');
  var elNotice = document.getElementById('notice');
  var elExplain = document.getElementById('explain').querySelector('tbody');
  var elPending = document.getElementById('pending-list');

  var LEVEL_TEXT = { L1: 'L1', L2: 'L2', L3: 'L3', L4: 'L4' };

  var REASON_TEXT = {
    required_evidence_missing: '必需证据未满足',
    unresolved_conflict: '存在未解决的表面冲突',
    parse_failure: '材料解析失败，证据不完整',
    no_evidence: '没有找到可核对的依据',
    criterion_is_judgment: '该评分点属于定性判断，系统不自动判定',
    level_undefined: '档位在细则中没有定义',
  };

  // ── 工具 ────────────────────────────────────────────────

  function setStatus(text, kind) {
    elStatus.textContent = text || '';
    elStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmt(value, digits) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!isFinite(n)) return '—';
    return n.toFixed(digits === undefined ? 1 : digits);
  }

  /** 统一的 API 调用：带游客头、把后端错误结构翻译成可读文案。 */
  function api(path, options) {
    var opts = options || {};
    var headers = { 'X-Visitor-Id': visitorId() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (payload) {
          if (!res.ok) {
            var message =
              payload && payload.error && payload.error.message
                ? payload.error.message
                : '请求失败（HTTP ' + res.status + '）';
            var error = new Error(message);
            error.status = res.status;
            throw error;
          }
          return payload;
        });
    });
  }

  // ── 加载细则 ────────────────────────────────────────────

  function loadRubrics() {
    return api('/api/rubrics')
      .then(function (data) {
        var items = (data && data.items) || [];
        clear(elRubric);

        if (items.length === 0) {
          elRubric.appendChild(
            el('option', null, '（没有评分细则，请先创建一份）')
          );
          elRubric.disabled = true;
          return;
        }

        items.forEach(function (item, index) {
          var label =
            item.title +
            ' · ' +
            item.course +
            ' (v' +
            item.version +
            ', ' +
            item.totalPoints +
            '分)';
          var option = el('option', null, label);
          option.value = item.rubricId;
          option.selected = index === 0;
          elRubric.appendChild(option);
        });
      })
      .catch(function (err) {
        clear(elRubric);
        elRubric.appendChild(el('option', null, '（加载失败）'));
        elRubric.disabled = true;
        setStatus('读取评分细则失败：' + err.message, 'error');
      });
  }

  // ── 渲染结果 ────────────────────────────────────────────

  function render(data) {
    var grade = data.grade || {};
    var stats = data.stats || {};
    var explain = data.explain || [];
    var dispositions = data.dispositions || [];

    elFinalTotal.textContent = fmt(grade.final_total, 1);

    var pending = stats.pendingCount || 0;
    elScoreSub.textContent =
      pending > 0
        ? '有 ' + pending + ' 个评分点待人工，当前值不是最终成绩'
        : '全部评分点已完成自动定级，待教师确认';

    elAutoPending.textContent = (stats.autoCount || 0) + ' / ' + pending;

    var kept = stats.quoteKept || 0;
    var dropped = stats.quoteDropped || 0;
    var total = kept + dropped;
    elQuoteRate.textContent =
      total > 0 ? Math.round((kept / total) * 100) + '%' : '—';

    elNotice.textContent = data.notice || '';

    elMeta.textContent =
      '细则 v' +
      data.rubricVersion +
      ' · 及格线 ' +
      data.passLine +
      ' · 用时 ' +
      fmt((stats.durationMs || 0) / 1000, 1) +
      ' 秒';

    // ── 逐分解释表 ──
    clear(elExplain);
    explain.forEach(function (row) {
      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.appendChild(el('span', 'crit-name', row.criterionName));
      if (row.levelDescriptor) {
        tdName.appendChild(el('span', 'crit-desc', row.levelDescriptor));
      }
      var adjustments = row.adjustments || [];
      adjustments.forEach(function (text) {
        tdName.appendChild(el('span', 'adjust', '⚙ ' + text));
      });
      tr.appendChild(tdName);

      tr.appendChild(el('td', 'num', fmt(row.weight, 0)));
      tr.appendChild(el('td', 'num level-tag', row.level ? LEVEL_TEXT[row.level] : '待人工'));
      tr.appendChild(el('td', 'num', row.scoreRatio === null ? '—' : fmt(row.scoreRatio, 2)));
      tr.appendChild(el('td', 'num', fmt(row.rawScore, 1)));

      var tdSource = document.createElement('td');
      var badge;
      if (row.source === 'pending') {
        badge = el('span', 'badge pending', '待人工');
      } else if (row.source === 'human') {
        badge = el('span', 'badge human', '教师改档');
      } else {
        badge = el('span', 'badge auto', '自动');
      }
      tdSource.appendChild(badge);
      tr.appendChild(tdSource);

      elExplain.appendChild(tr);
    });

    // ── 待人工清单 ──
    clear(elPending);
    var pendingItems = dispositions.filter(function (d) {
      return d.status === 'pending';
    });

    pendingItems.forEach(function (d) {
      var li = document.createElement('li');
      li.appendChild(el('strong', null, d.criterionName));

      var reasons = (d.reasons || []).map(function (code) {
        return REASON_TEXT[code] || code;
      });
      if (reasons.length > 0) {
        li.appendChild(el('span', 'reason', '原因：' + reasons.join('、')));
      }
      if (d.detail) {
        li.appendChild(el('span', 'reason', d.detail));
      }
      li.appendChild(
        el('span', 'reason', '请人工判断该评分点应归入哪一档。')
      );

      elPending.appendChild(li);
    });

    elResult.hidden = false;
  }

  // ── 触发评阅 ────────────────────────────────────────────

  function runGrade() {
    var rubricId = elRubric.value;
    var text = elReport.value.trim();

    if (!rubricId) {
      setStatus('请先选择一份评分细则', 'error');
      return;
    }
    if (text.length < 20) {
      setStatus('报告正文太短，请粘贴完整正文', 'error');
      return;
    }

    elRun.disabled = true;
    setStatus('正在评阅：逐评分点检索证据、核对引文、匹配档位…（约 1–2 分钟）');

    api('/api/grade', {
      method: 'POST',
      body: { rubricId: rubricId, materialId: 'm1', text: text },
    })
      .then(function (data) {
        render(data);
        setStatus(
          '完成。共 ' + (data.stats.criteriaCount || 0) + ' 个评分点。',
          'ok'
        );
        if (elResult.scrollIntoView) {
          elResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      })
      .catch(function (err) {
        setStatus('评阅失败：' + err.message, 'error');
      })
      .then(function () {
        elRun.disabled = false;
      });
  }

  // ── 绑定 ────────────────────────────────────────────────

  elRun.addEventListener('click', runGrade);
  elSample.addEventListener('click', function () {
    elReport.value = SAMPLE_REPORT;
    setStatus('已载入示例报告（内含「正文声称与代码不一致」与「缺少信号处理」两处缺陷）');
  });

  loadRubrics();
})();
