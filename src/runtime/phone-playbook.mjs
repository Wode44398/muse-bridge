// 「手机操控经验库」——按 app 持久化 Claude 实战沉淀的操作套路 + 坑，让它对主流操作越来越熟练。
//
// 设计：出厂为空，内容【全部来自 Claude 运行时通过 phone_learn 写入】，不预置任何套路
// （维护者定调：注入后要不要回车这类细节靠 Claude 自己试出来再沉淀）。存 JSON 在项目根
// phone-control-playbook.json（同 phone-control-audit.log 的 ROOT 约定）。
//
// 跨会话 / 跨驾驶员共享：PC 上的 Claude Code 与悬浮胶囊里的 Claude 读【同一份】——经验属于
// 「这台手机的这些 app」，不属于某次会话。坐标统一记 0~1 比例，换设备也通用。
//
// 结构：
//   { apps: { "<归一化名/包名>": {
//       names:   ["微信","com.tencent.mm"],          // 见过的名字（中文名/包名都留，供互查）
//       traits:  ["读不到无障碍元素,全程截图+coord"], // app 级特性
//       tasks:   { "<归一化任务>": { task, steps, gotchas, verified, count } },
//       updated: ISO
//   } } }

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config/index.mjs';

const FILE = path.join(ROOT, 'phone-control-playbook.json');
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// 内存缓存：经验库原本每次 recall/learn 都读盘。缓存住、按文件 mtime 失效（PC 侧 Claude Code
// 与悬浮胶囊里的 Claude 读同一份，外部改了文件 → mtime 变 → 自动重读）。挂载 Claude 时
// preloadPlaybook() 暖一次，之后首次 phone_open_app/phone_recall 直接命中内存、不读盘。
let _cache = null;
let _cacheMtimeMs = -1;

function load() {
  try {
    if (!existsSync(FILE)) { _cache = {}; _cacheMtimeMs = -1; return _cache; }
    const m = statSync(FILE).mtimeMs;
    if (_cache && m === _cacheMtimeMs) return _cache;   // 文件没变 → 命中缓存
    _cache = JSON.parse(readFileSync(FILE, 'utf8')) || {};
    _cacheMtimeMs = m;
    return _cache;
  } catch { return _cache || {}; }
}
function save(db) {
  try {
    writeFileSync(FILE, JSON.stringify(db, null, 2));
    _cache = db;   // 刚写盘的就是最新缓存，省掉下一次 load 的读盘
    try { _cacheMtimeMs = statSync(FILE).mtimeMs; } catch { _cacheMtimeMs = -1; }
    return true;
  } catch { return false; }
}

/**
 * 预热：把经验库整个读进内存缓存（挂载 Claude 到悬浮胶囊时调一次）。返回已沉淀的 app 数。
 * 纯进程级、零副作用——不发对话、不起 query，只是把后续 recall/learn 的首次读盘提前到挂载时。
 */
export function preloadPlaybook() {
  const db = load();
  return Object.keys(db.apps || {}).length;
}

// 找某 app 的条目：先精确归一化 key，再扫各条 names 的归一化匹配（同 app 不同名互查）。
function findApp(db, app) {
  const key = norm(app);
  if (!key) return null;
  const apps = db.apps || {};
  if (apps[key]) return { key, rec: apps[key] };
  for (const [k, rec] of Object.entries(apps)) {
    if ((rec.names || []).map(norm).includes(key)) return { key: k, rec };
  }
  return null;
}

/** 读经验：返回该 app 的记录（{names,traits,tasks,updated}）或 null。 */
export function recallApp(app) {
  const hit = findApp(load(), app);
  return hit ? hit.rec : null;
}

/**
 * 写经验：合并进该 app。task 留空=只更新 app 级 traits/names。
 * 同一 app+task 再次写=更新 steps/gotchas 并累加 count（验证次数，越多越可信）。
 * nowIso 可注入（测试用），默认 new Date()（bridge 运行时即 Node，audit() 同款用法）。
 */
export function learnApp({ app, task, steps, gotchas, traits, combo, nowIso } = {}) {
  if (!app || !norm(app)) return null;
  const now = nowIso || new Date().toISOString();
  const db = load();
  if (!db.apps) db.apps = {};
  const hit = findApp(db, app);
  let rec;
  if (hit) rec = hit.rec;
  else { rec = { names: [], traits: [], tasks: {}, updated: now }; db.apps[norm(app)] = rec; }
  if (!rec.names) rec.names = [];
  if (!rec.names.map(norm).includes(norm(app))) rec.names.push(String(app).trim());
  // app 级 traits：追加去重
  if (traits != null) {
    if (!rec.traits) rec.traits = [];
    for (const t of (Array.isArray(traits) ? traits : [traits])) {
      const tt = String(t).trim();
      if (tt && !rec.traits.includes(tt)) rec.traits.push(tt);
    }
  }
  // task 级套路：合并更新 + 累加验证次数
  if (task != null && String(task).trim()) {
    if (!rec.tasks) rec.tasks = {};
    const tk = norm(task);
    const prev = rec.tasks[tk] || { count: 0 };
    rec.tasks[tk] = {
      task: String(task).trim(),
      // 旧版的 combo（「可连贯执行、中间不截图」的坐标串）已废止：换机型/双栏/键盘弹起时盲点会点错，
      // 发消息类任务可能发错人。还传 combo 的当参考步骤收下；旧数据里的 combo 也并进 steps。
      steps: steps != null ? String(steps).trim() : (combo != null ? String(combo).trim() : (prev.steps || prev.combo || '')),
      gotchas: gotchas != null ? String(gotchas).trim() : (prev.gotchas || ''),
      verified: now,
      count: (prev.count || 0) + 1,
    };
  }
  rec.updated = now;
  save(db);
  return rec;
}

/**
 * 把【包名】登记进某 app【已有】经验条目的 names，供「读屏按包名反查经验」用。
 * open_app 解析出 label↔pkg 后调一次；只往已有条目补 pkg，【绝不为无经验的 app 建空条目】。
 */
export function linkAppPkg(app, pkg) {
  if (!app || !pkg) return;
  const p = String(pkg).trim();
  if (!p) return;
  const db = load();
  const hit = findApp(db, app);
  if (!hit) return;                                    // 没经验就别建空壳
  if (!hit.rec.names) hit.rec.names = [];
  if (!hit.rec.names.map(norm).includes(norm(p))) { hit.rec.names.push(p); save(db); }
}

/** 格式化给 Claude 看的紧凑文本（open_app 自动带回 / phone_recall / 读屏检测 用）。无经验返回 ''。 */
export function formatPlaybook(app) {
  const rec = recallApp(app);
  if (!rec) return '';
  const lines = [];
  const traits = (rec.traits || []).filter(Boolean);
  if (traits.length) lines.push('· 特性：' + traits.join('；'));
  for (const t of Object.values(rec.tasks || {})) {
    let line = '· 【' + t.task + '】';
    const steps = t.steps || t.combo || '';   // 旧数据里的 combo 只当参考步骤，照样每步看画面再动手
    if (steps) line += ' 做法：' + steps;
    if (t.gotchas) line += '　⚠ ' + t.gotchas;
    if (t.count > 1) line += '　(验证过 ' + t.count + ' 次)';
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 文字提到：在一段文字（用户本轮消息）里扫出【已有经验】的 app —— 按各条目 names 里的名字（中文名/包名，
 * 长度≥2 防误命中）做子串匹配，命中就把该 app 的完整经验拼进去。注入本轮 systemPrompt，让 Claude 在
 * 用户【嘴上提到】某个 app（还没读屏/没开）时就带着经验上手。无匹配返回 ''。
 */
export function playbookForMention(text) {
  const t = String(text || '');
  if (!t.trim()) return '';
  const apps = (load().apps) || {};
  const seen = new Set();
  const blocks = [];
  for (const rec of Object.values(apps)) {
    const names = (rec.names || []).map((n) => String(n).trim()).filter((n) => n.length >= 2);
    const hitName = names.find((n) => t.includes(n));
    if (!hitName) continue;
    const title = (rec.names && rec.names[0]) || hitName;
    if (seen.has(title)) continue;
    seen.add(title);
    const body = formatPlaybook(hitName);
    if (body) blocks.push('· 【' + title + '】\n' + body);
  }
  if (!blocks.length) return '';
  return '\n\n【本轮用户提到、以前记过经验的 app（参考；坐标可能随机型/布局失效，以当前画面为准，失效就 phone_learn 更新）】\n'
    + blocks.join('\n');
}

/**
 * 全库摘要——挂载/操控时注入会话 systemPrompt，让 Claude 一开始就「带着」本机经验、少试探（这就是
 * 「预热」对 Claude 的可见兑现：经开机即就绪，不必先 recall）。每行=一个 app 的 traits + 会的任务名；
 * 详细步骤/坐标仍靠 phone_recall / open_app 自动带回完整版（避免把全库步骤塞满上下文）。无经验返回 ''。
 */
export function playbookSummary() {
  const apps = (load().apps) || {};
  const recs = Object.values(apps);
  if (!recs.length) return '';
  const lines = [];
  for (const rec of recs) {
    const name = (rec.names && rec.names[0]) || '?';
    const traits = (rec.traits || []).filter(Boolean).join('；');
    const taskNames = Object.values(rec.tasks || {}).map((t) => t.task).filter(Boolean);
    let line = '· ' + name;
    if (traits) line += '：' + traits;
    if (taskNames.length) line += '　已会：' + taskNames.join('、');
    lines.push(line);
  }
  return '\n\n【手机操控经验库里记过的 app】\n'
    + lines.join('\n')
    + '\n打开这些 app 时会自动带回详细做法（参考，以当前画面为准）；委派 phone-operator 时不用转述。';
}
