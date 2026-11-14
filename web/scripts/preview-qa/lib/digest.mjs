// report.json → 数值摘要（run.mjs 写进 summary.md 的「数值摘要」一节；compare.mjs 也用这里的取数口径）。
// 口径：
//   侧滑 readyMs = 抬手到目标图在视口中心完整画出（解码完、不透明度 ≥0.99）再加一帧；decodedMs = 抬手到目标图已解码挂上 DOM（不论透明度）；
//   blankFrames = 抬手后、出图前视口中心什么都没画出来的帧数（8 划合计）；openMs = 调 openPreview 到判定渲染成功（Node 侧计时）。

/** 取一个场景里可比较的标量指标：{ 名字: 数值|布尔|null } */
export function scalars(rec) {
  const m = rec?.metrics || {};
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith('_') || k === 'localServer') continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 统计对象（swipe 的 readyMs 等）只取中位与最差；其它对象取一层数值字段（如 ctrlWheel.scale、play.advanced）
      if ('median' in v && 'max' in v) { out[k + '.median'] = v.median; out[k + '.max'] = v.max; }
      else for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number' || typeof v2 === 'boolean') out[k + '.' + k2] = v2;
    }
  }
  return out;
}

/** 汇总：返回 markdown 行数组 */
export function digest(report) {
  const L = [];
  const R = report.results || {};
  // —— 侧滑 ——
  const sw = [];
  for (const [p, rs] of Object.entries(R)) for (const x of rs) if (x.id?.startsWith('swipe-') && x.metrics) sw.push({ p, x });
  if (sw.length) {
    L.push('### 侧滑：松手到出图（ms）', '', '| 档 | 场景 | 中位 | 最差 | 解码中位 | 空白帧 | 仅模糊底帧 | 长帧 | 首张出图 |', '|---|---|---|---|---|---|---|---|---|');
    for (const { p, x } of sw) {
      const m = x.metrics;
      L.push(`| ${p} | ${x.id} | ${m.readyMs?.median ?? '—'} | ${m.readyMs?.max ?? '—'} | ${m.decodedMs?.median ?? '—'} | ${m.blankFrames ?? '—'} | ${m.blurOnlyFrames ?? '—'} | ${m.longFrames ?? '—'} | ${m.firstOpenMs ?? '—'} |`);
    }
    const all = sw.map(({ x }) => x.metrics);
    const meds = all.map((m) => m.readyMs?.median).filter((v) => v != null).sort((a, b) => a - b);
    const worst = Math.max(...all.map((m) => m.readyMs?.max ?? 0));
    const blanks = all.reduce((s, m) => s + (m.blankFrames || 0), 0);
    if (meds.length) L.push('', `合计：${sw.length} 组 × 8 划，各组中位数 ${meds[0]}–${meds[meds.length - 1]}ms，最差单划 ${worst}ms，空白帧合计 ${blanks}。`);
    L.push('');
  }
  // —— 桌面缩放 ——
  const dz = [];
  for (const [p, rs] of Object.entries(R)) for (const x of rs) if (x.id === 'desk-wheel-zoom' && x.metrics) dz.push({ p, m: x.metrics, a: x.asserts || [] });
  if (dz.length) {
    L.push('### 电脑看图：滚轮 / Ctrl+滚轮 / 拖动 / 键盘', '', '| 档 | 滚轮改了图 | 滚轮后缩放 | Ctrl+滚轮改了图 | Ctrl 后缩放 | 页面缩放 vv | 拖动平移 | 键盘 + |', '|---|---|---|---|---|---|---|---|');
    for (const { p, m, a } of dz) {
      const g = (n) => { const x = a.find((y) => y.name === n); return x ? (x.ok ? '有' : '无') : '—'; };
      L.push(`| ${p} | ${m.wheelChanged ? '是' : '否'} | ${m.wheel?.scale ?? '—'} | ${m.ctrlWheelChanged ? '是' : '否'} | ${m.ctrlWheel?.scale ?? '—'} | ${m.ctrlWheel?.vv ?? '—'} | ${g('放大后拖动平移')} | ${g('键盘 + 放大')} |`);
    }
    L.push('');
  }
  // —— 打开耗时 ——
  const open = {};
  const profs = Object.keys(R);
  for (const [p, rs] of Object.entries(R)) for (const x of rs) if (/^(local-)?open-/.test(x.id || '')) (open[x.id] ||= {})[p] = x;
  if (Object.keys(open).length) {
    L.push('### 打开耗时 openMs（✗ = must 断言不过或出错；— = 该档没跑或没量到）', '', '| 场景 | ' + profs.join(' | ') + ' |', '|---|' + profs.map(() => '---|').join(''));
    for (const [id, v] of Object.entries(open)) {
      L.push(`| ${id} | ` + profs.map((p) => { const x = v[p]; if (!x) return '—'; const ms = x.metrics?.openMs; return (x.ok ? '' : '✗ ') + (ms ?? '—'); }).join(' | ') + ' |');
    }
    L.push('');
  }
  // —— 改版目标 ——
  const goals = {};
  for (const [p, rs] of Object.entries(R)) for (const x of rs) for (const a of x.asserts || []) if (a.level === 'goal') { const k = x.id + ' :: ' + a.name; (goals[k] ||= { ok: 0, n: 0 }); goals[k].n++; if (a.ok) goals[k].ok++; }
  if (Object.keys(goals).length) {
    L.push('### 改版目标（goal 断言，达成档数 / 跑过档数）', '');
    for (const [k, v] of Object.entries(goals)) L.push(`- ${k}：${v.ok}/${v.n}`);
    L.push('');
  }
  // —— 通用检测 ——
  const iss = {};
  for (const rs of Object.values(R)) for (const x of rs) for (const it of x.issues || []) iss[it.type] = (iss[it.type] || 0) + 1;
  if (Object.keys(iss).length) L.push('### 通用检测问题（按类型计数）', '', Object.entries(iss).map(([t, n]) => `\`${t}\` ${n}`).join('　'), '');
  return L;
}

/** 控制台版（compare / 调试用）：去掉表格竖线对齐 */
export function digestText(report) { return digest(report).map((l) => l.replace(/^\|\s?|\s?\|$/g, '').replace(/\s\|\s/g, '  ')).join('\n'); }
