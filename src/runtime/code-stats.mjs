// Claude Code 用量统计：给新对话空态的「概览 / 模型」用量卡供数（GET /api/claude/code-stats）。
//
// 数据来源是某个 Claude 配置目录下的会话转录 projects/<项目>/*.jsonl，外加子代理转录
// projects/<项目>/<会话>/subagents/agent-*.jsonl；CLI 自己维护的 stats-cache.json 若可用，就当作
// 「截至某日」的历史底数，窗口只从它的次日开始扫，更早的日子直接沿用底数。
//
// 设计要点：
// - 按天聚合消息数 / 会话数 / 工具调用数，按模型聚合 token；日期与小时一律按进程本地时区。
// - 三层缓存：
//   1. 结果缓存：同一配置目录 5 分钟内直接复用上次的载荷对象；
//   2. 进行中合并：同一配置目录同时只算一次，后来的调用（含 force）拿同一个 Promise；
//   3. 单文件汇总缓存：(路径, mtime, 大小) 不变的转录不重读，汇总落盘到 dataDir/code-stats-cache.json，
//      重启后接着用。汇总不按窗口截断，窗口过滤只在聚合时做，所以缓存与窗口无关。
// - 主转录与子代理转录口径不同：子代理文件的旁支记录也算，但不产生会话、不计消息，
//   工具调用只并入主转录已有的日行，token 全计。类别看路径里有没有独立的 subagents 一段。
// - 文件系统层面的问题（目录读不了、stat 失败、读到一半出错、缓存读写失败）一律静默降级；
//   底数文件结构本身坏掉（数组里混进 null 等）则让计算失败，路由回 500。
// - 只依赖 Node 内置模块；所有模块级状态都在本文件里（换一个模块实例 = 冷启动）。
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DAY_MS = 86400000;
const WINDOW_DAYS = 182;                 // 没有底数时往回看的天数
const RESULT_TTL_MS = 300000;            // 结果缓存有效期
const MAX_FILE_BYTES = 1073741824;       // 单个转录超过 1 GiB 不看
const MAX_LINE_UNITS = 16777216;         // 单行超过 16 Mi 个 UTF-16 码元整行丢弃
const MIN_SEED_VERSION = 5;              // 底数里 dailyModelTokens 的口径版本下限
const SEED_NAME = 'stats-cache.json';
const MEMO_NAME = 'code-stats-cache.json';
const MEMO_VERSION = 1;
const SUBAGENT_SEGMENT = `${path.sep}subagents${path.sep}`;
const IO_CONCURRENCY = 16;               // 同时 stat / 读取的文件数上限
const SYNTHETIC_MODEL = '<synthetic>';

const finished = new Map();              // 配置目录 -> { payload, at }
const inflight = new Map();              // 配置目录 -> 进行中的 Promise
const memos = new Map();                 // 配置目录 -> 单文件汇总缓存（见 openMemo）

// —— 配置目录 ——

export function claudeConfigDirFor(ctx) {
  return ctx?.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// —— 入口：结果缓存 + 进行中合并 ——

export function getCodeStats(ctx, options = {}) {
  const force = !!options?.force;
  const dir = claudeConfigDirFor(ctx);

  const last = finished.get(dir);
  if (!force && last && Date.now() - last.at < RESULT_TTL_MS) return Promise.resolve(last.payload);

  const running = inflight.get(dir);
  if (running) return running;

  const job = computeStats(dir, ctx?.dataDir).then((payload) => {
    finished.set(dir, { payload, at: Date.now() });
    return payload;
  });
  inflight.set(dir, job);
  // 先于调用方挂上的收尾：无论成败都撤销「进行中」登记（这条链自己吞掉拒绝，拒绝仍由 job 交给调用方）
  const release = () => { if (inflight.get(dir) === job) inflight.delete(dir); };
  job.then(release, release);
  return job;
}

// —— 本地日历 ——

const pad2 = (n) => String(n).padStart(2, '0');

// 某个时刻在本地时区的 YYYY-MM-DD
function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 日期键当天的本地 0 点：交给 Date 按「无时区后缀 = 本地时间」解析。
// 种子里的 lastComputedDate 若不是规范的 YYYY-MM-DD，就按 Date 解析器的结果走（解析不了则为无效时间）。
function localMidnight(key) {
  return new Date(`${key}T00:00:00`);
}

// 日期键在本地日历上平移若干天（跨月、跨年自动进位）
function shiftDayKey(key, delta) {
  const t = localMidnight(key);
  t.setDate(t.getDate() + delta);
  return dayKeyOf(t);
}

// —— 底数文件 stats-cache.json ——

async function readSeed(dir) {
  let seed;
  try {
    seed = JSON.parse(await readFile(path.join(dir, SEED_NAME), 'utf8'));
  } catch {
    return null;
  }
  if (!seed || typeof seed !== 'object') return null;
  if (!Array.isArray(seed.dailyActivity)) return null;
  if (!((seed.dailyModelTokensVersion ?? 0) >= MIN_SEED_VERSION)) return null;
  return seed;
}

// —— 找转录 ——

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// 返回候选文件路径（未分类）。只认目录项类型：符号链接 / 目录联接一律不跟。
async function findTranscripts(dir) {
  const root = path.join(dir, 'projects');
  const projects = (await listDir(root)).filter((e) => e.isDirectory());
  const perProject = await Promise.all(projects.map(async (proj) => {
    const out = [];
    const entries = await listDir(path.join(root, proj.name));
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.includes('.superseded-')) {
        out.push(path.join(dir, 'projects', proj.name, e.name));
      }
    }
    const sessions = entries.filter((e) => e.isDirectory());
    const nested = await Promise.all(sessions.map(async (s) => {
      const found = await listDir(path.join(root, proj.name, s.name, 'subagents'));
      return found
        .filter((f) => f.isFile() && f.name.startsWith('agent-') && f.name.endsWith('.jsonl'))
        .map((f) => path.join(dir, 'projects', proj.name, s.name, 'subagents', f.name));
    }));
    for (const list of nested) out.push(...list);
    return out;
  }));
  return perProject.flat();
}

const isSubagentPath = (file) => file.includes(SUBAGENT_SEGMENT);

// —— 逐行读取 ——
// \n、\r\n、单独的 \r 都是换行（\r\n 被分块切开也只算一次）；空行不回调；超长行整行丢弃；
// 不剥离 BOM（流按 UTF-8 解码，开头的 U+FEFF 会留在第一行里）。

const LINE_BREAK = /[\r\n]/g;
const CR = 13;
const LF = 10;

async function forEachLine(file, onLine) {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let line = '';
  let overflow = false;        // 当前行已超长：剩余部分丢到下一个换行为止
  let crAtChunkEnd = false;    // 上一块以 \r 收尾：本块开头的 \n 与它是同一次换行
  for await (const chunk of stream) {
    if (!chunk.length) continue;
    let i = 0;
    if (crAtChunkEnd) {
      crAtChunkEnd = false;
      if (chunk.charCodeAt(0) === LF) i = 1;
    }
    while (i < chunk.length) {
      LINE_BREAK.lastIndex = i;
      const hit = LINE_BREAK.exec(chunk);
      const end = hit ? hit.index : chunk.length;
      if (!overflow) {
        if (line.length + (end - i) > MAX_LINE_UNITS) {
          overflow = true;
          line = '';
        } else {
          line += chunk.slice(i, end);
        }
      }
      if (!hit) break;
      if (!overflow && line) onLine(line);
      line = '';
      overflow = false;
      if (chunk.charCodeAt(end) === CR) {
        if (end + 1 === chunk.length) {
          crAtChunkEnd = true;
          i = end + 1;
        } else {
          i = chunk.charCodeAt(end + 1) === LF ? end + 2 : end + 1;
        }
      } else {
        i = end + 1;
      }
    }
  }
  if (!overflow && line) onLine(line);
}

// —— 单文件汇总 ——
// 结果 { firstTs, days: { 日期: { messageCount, toolCallCount, usageByModel: { 模型: 四项 } } } }，
// 没有任何计数记录时为 null。模型名可能是 __proto__ 之类，所以累加时一律用 Map，输出时再转对象。

const zeroUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

async function summarizeTranscript(file, keepSidechain) {
  const days = new Map();
  let firstTs;
  let counted = false;

  await forEachLine(file, (text) => {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return;
    }
    if (rec === null || typeof rec !== 'object') return;
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    if (rec.userType === 'ant') return;
    if (!keepSidechain && rec.isSidechain) return;
    const ts = rec.timestamp;
    if (!ts) return;
    const when = new Date(ts);
    if (Number.isNaN(when.getTime())) return;

    if (!counted) {
      counted = true;
      firstTs = ts;
    }
    const key = dayKeyOf(when);
    let day = days.get(key);
    if (!day) {
      day = { messageCount: 0, toolCallCount: 0, usage: new Map() };
      days.set(key, day);
    }
    day.messageCount += 1;
    if (rec.type !== 'assistant') return;

    const msg = rec.message;
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const part of content) if (part && part.type === 'tool_use') day.toolCallCount += 1;
    }
    const usage = msg?.usage;
    if (!usage) return;
    const model = msg.model ?? 'unknown';
    if (model === SYNTHETIC_MODEL) return;
    const name = String(model);
    let acc = day.usage.get(name);
    if (!acc) {
      acc = zeroUsage();
      day.usage.set(name, acc);
    }
    acc.inputTokens += usage.input_tokens ?? 0;
    acc.outputTokens += usage.output_tokens ?? 0;
    acc.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    acc.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  });

  if (!counted) return null;
  const out = {};
  for (const [key, day] of days) {
    out[key] = {
      messageCount: day.messageCount,
      toolCallCount: day.toolCallCount,
      usageByModel: Object.fromEntries(day.usage),
    };
  }
  return { firstTs, days: out };
}

// —— 单文件汇总的持久缓存 ——
// 每个配置目录一份：路径 -> { m: mtime 毫秒, s: 字节数, sum: 汇总或 null }。
// 落盘位置在本进程第一次为该配置目录计算时定下，之后不随 dataDir 变化。

function openMemo(dir, dataDir) {
  let memo = memos.get(dir);
  if (memo) return memo;
  memo = {
    file: dataDir ? path.join(dataDir, MEMO_NAME) : null,
    entries: new Map(),
    dirty: false,
    ready: null,
  };
  memo.ready = memo.file ? loadMemo(memo, dir) : Promise.resolve();
  memos.set(dir, memo);
  return memo;
}

async function loadMemo(memo, dir) {
  try {
    const saved = JSON.parse(await readFile(memo.file, 'utf8'));
    if (!saved || typeof saved !== 'object') return;
    if (saved.v !== MEMO_VERSION || saved.configDir !== dir || !saved.files) return;
    for (const [file, entry] of Object.entries(saved.files)) memo.entries.set(file, entry);
  } catch {
    // 不存在或损坏：从空开始
  }
}

async function saveMemo(memo, dir) {
  if (!memo.dirty || !memo.file) return;
  memo.dirty = false;
  const tmp = `${memo.file}.tmp`;
  try {
    await mkdir(path.dirname(memo.file), { recursive: true });
    const body = JSON.stringify({ v: MEMO_VERSION, configDir: dir, files: Object.fromEntries(memo.entries) });
    await writeFile(tmp, body);
    await rename(tmp, memo.file);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// 单个候选文件：stat 过滤 → 查缓存 → 必要时读文件。返回 null 表示本轮不纳入。
async function loadSummary(memo, file, fromMs) {
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  if (st.mtimeMs < fromMs || st.size > MAX_FILE_BYTES) return null;

  const cached = memo.entries.get(file);
  if (cached && cached.m === st.mtimeMs && cached.s === st.size) return { sum: cached.sum ?? null };

  let sum = null;
  if (st.isFile()) {
    try {
      sum = await summarizeTranscript(file, isSubagentPath(file));
    } catch {
      return { sum: null };          // 读到一半出错：本轮当空，不进缓存
    }
  }
  memo.entries.set(file, { m: st.mtimeMs, s: st.size, sum });
  memo.dirty = true;
  return { sum };
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// —— 聚合 ——

function newTally(seed, from) {
  const tally = {
    from,
    rows: new Map(),           // 日期 -> 每日行
    dayTokens: new Map(),      // 日期 -> Map(模型 -> token 和)
    usage: new Map(),          // 模型 -> 四项
    hours: new Map(),          // 小时 -> 次数（Map 的插入顺序就是登记顺序）
    totalSessions: 0,
    totalMessages: 0,
    firstSessionDate: null,
    lastSessionDate: null,
  };
  if (!seed) return tally;

  for (const item of seed.dailyActivity) {
    if (item.date < from) tally.rows.set(item.date, { ...item });
  }
  // 缺失才当空；存在但不可迭代（对象、数字）同样让计算失败
  for (const item of seed.dailyModelTokens ?? []) {
    if (item.date < from) tally.dayTokens.set(item.date, new Map(Object.entries(item.tokensByModel || {})));
  }
  for (const [model, u] of Object.entries(seed.modelUsage || {})) {
    tally.usage.set(model, {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
    });
  }
  for (const [hour, count] of Object.entries(seed.hourCounts || {})) tally.hours.set(Number(hour), count);
  tally.totalSessions = seed.totalSessions ?? 0;
  tally.totalMessages = seed.totalMessages ?? 0;
  tally.firstSessionDate = seed.firstSessionDate ?? null;
  return tally;
}

function rowFor(tally, date) {
  let row = tally.rows.get(date);
  if (!row) {
    row = { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
    tally.rows.set(date, row);
  }
  return row;
}

function addModelUsage(tally, date, usageByModel) {
  for (const [model, u] of Object.entries(usageByModel)) {
    let acc = tally.usage.get(model);
    if (!acc) {
      acc = zeroUsage();
      tally.usage.set(model, acc);
    }
    acc.inputTokens += u.inputTokens;
    acc.outputTokens += u.outputTokens;
    acc.cacheReadInputTokens += u.cacheReadInputTokens;
    acc.cacheCreationInputTokens += u.cacheCreationInputTokens;
    const total = u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    if (total > 0) {
      let perModel = tally.dayTokens.get(date);
      if (!perModel) {
        perModel = new Map();
        tally.dayTokens.set(date, perModel);
      }
      perModel.set(model, (perModel.get(model) ?? 0) + total);
    }
  }
}

function addMainSummary(tally, sum) {
  const start = new Date(sum.firstTs);
  const startKey = dayKeyOf(start);
  if (startKey >= tally.from) {
    tally.totalSessions++;              // 自增按数值走（种子给的是字符串时也是数值加一）
    rowFor(tally, startKey).sessionCount++;
    const hour = start.getHours();
    tally.hours.set(hour, (tally.hours.get(hour) ?? 0) + 1);
    // 比的是原始值（字符串按码元字典序），不换算成时间
    if (!tally.firstSessionDate || sum.firstTs < tally.firstSessionDate) tally.firstSessionDate = sum.firstTs;
    if (!tally.lastSessionDate || sum.firstTs > tally.lastSessionDate) tally.lastSessionDate = sum.firstTs;
  }
  for (const [date, day] of Object.entries(sum.days)) {
    if (date < tally.from) continue;
    const row = rowFor(tally, date);
    row.messageCount += day.messageCount;
    tally.totalMessages += day.messageCount;
    row.toolCallCount += day.toolCallCount;
    addModelUsage(tally, date, day.usageByModel);
  }
}

function addSubagentSummary(tally, sum) {
  for (const [date, day] of Object.entries(sum.days)) {
    if (date < tally.from) continue;
    const row = tally.rows.get(date);
    if (row) row.toolCallCount += day.toolCallCount;   // 没有主转录日行的那天，工具调用不计
    addModelUsage(tally, date, day.usageByModel);
  }
}

function peakHour(hours) {
  let best = 0;
  let peak = null;
  for (const [hour, count] of hours) {
    if (count > best) {
      best = count;
      peak = hour;
    }
  }
  return peak;
}

function streaksOf(dates) {
  if (!dates.length) return { currentStreak: 0, longestStreak: 0 };
  const present = new Set(dates);
  let currentStreak = 0;
  for (let key = dayKeyOf(new Date()); present.has(key); key = shiftDayKey(key, -1)) currentStreak += 1;

  const sorted = [...dates].sort();      // 默认排序：按字符串形式的码元顺序
  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round((new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / DAY_MS);
    run = gap === 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
  }
  return { currentStreak, longestStreak };
}

// 输出数组按 date 的 localeCompare 升序（规范的 YYYY-MM-DD 下与字典序一致；种子里的非规范日期按区域排序规则排；
// 种子行的 date 不是字符串时，排序中它若落在比较的左侧就会因没有 localeCompare 而让计算失败）
const byDate = (a, b) => a.date.localeCompare(b.date);

function buildPayload(tally) {
  const dailyActivity = [...tally.rows.values()].sort(byDate);
  const dailyModelTokens = [...tally.dayTokens]
    .map(([date, perModel]) => ({ date, tokensByModel: Object.fromEntries(perModel) }))
    .sort(byDate);
  return {
    totalSessions: tally.totalSessions,
    totalMessages: tally.totalMessages,
    activeDays: tally.rows.size,
    firstSessionDate: tally.firstSessionDate,
    lastSessionDate: tally.lastSessionDate,
    peakActivityHour: peakHour(tally.hours),
    streaks: streaksOf(dailyActivity.map((row) => row.date)),
    dailyActivity,
    dailyModelTokens,
    modelUsage: Object.fromEntries(tally.usage),
  };
}

// —— 一次完整计算 ——

async function computeStats(dir, dataDir) {
  const memo = openMemo(dir, dataDir);
  await memo.ready;

  const seed = await readSeed(dir);
  const from = seed?.lastComputedDate
    ? shiftDayKey(seed.lastComputedDate, 1)
    : dayKeyOf(new Date(Date.now() - WINDOW_DAYS * DAY_MS));
  const fromMs = localMidnight(from).getTime();
  const tally = newTally(seed, from);

  const candidates = await findTranscripts(dir);
  const loaded = await mapLimited(candidates, IO_CONCURRENCY, (file) => loadSummary(memo, file, fromMs));

  const included = new Set();
  const mains = [];
  const subs = [];
  candidates.forEach((file, i) => {
    const got = loaded[i];
    if (!got) return;
    included.add(file);
    if (got.sum) (isSubagentPath(file) ? subs : mains).push(got.sum);
  });

  for (const file of memo.entries.keys()) {
    if (!included.has(file)) {
      memo.entries.delete(file);
      memo.dirty = true;
    }
  }

  // 聚合在落盘之前：缓存里的汇总若结构坏掉导致聚合抛错，这一轮不落盘（「有变化」标记留到下一轮）
  for (const sum of mains) addMainSummary(tally, sum);
  for (const sum of subs) addSubagentSummary(tally, sum);
  await saveMemo(memo, dir);
  return buildPayload(tally);
}
