// 子 agent 调用策略子页的纯函数：草稿的规整与比较、策略名与推理强度的叫法、模型写法换算、四档落点的本地预估与交给图的那份、
// 浮层的锚点与键盘走位、防连点、数字与时间的写法。
// 不依赖 DOM、状态模块与翻译层（dpUtil.test.js 用 node --test 直接跑）；要出现在界面上的词由调用方传进来。
// 判定线取整、落点规则与性价比图是同一份实现（lib/dispatchChartMath.js），这里只在它上面包草稿的那一层。
import { pickForFloor, roundFloor } from '../../../lib/dispatchChartMath.js';

export const TIER_KEYS = ['top', 'hard', 'normal', 'light'];
export const NAME_MAX = 24;          // 策略名 1–24 字（契约 §2.1）
export const NOTE_MAX = 2000;        // 口述备注上限
export const STRATEGY_MAX = 12;      // 最多 12 套
export const CHART_MAX_BYTES = 12 * 1024 * 1024;   // 性价比图 HTML 的上传上限

const floorNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? roundFloor(v) : null);

// —— 草稿 ——
// 策略里能在子页改的只有四样：名字、四条判定线、四档的指定模型、备注。草稿是它们的深拷贝。
export function draftOf(s) {
  const f = (s && s.floors) || {}, o = (s && s.overrides) || {};
  const floors = {}, overrides = {};
  for (const k of TIER_KEYS) {
    floors[k] = floorNum(f[k]);
    const ov = o[k];
    overrides[k] = ov && typeof ov.model === 'string' && ov.model ? { model: ov.model, effort: typeof ov.effort === 'string' ? ov.effort : '' } : null;
  }
  return { id: (s && s.id) || '', name: String((s && s.name) || ''), floors, overrides, note: String((s && s.note) || '') };
}

const sameOv = (a, b) => (!a && !b) || (!!a && !!b && a.model === b.model && (a.effort || '') === (b.effort || ''));
/** 哪几样改过：{ name, floors, overrides, note, any }。 */
export function draftDiff(a, b) {
  const d = { name: false, floors: false, overrides: false, note: false, any: false };
  if (!a || !b) return d;
  d.name = a.name !== b.name;
  d.note = a.note !== b.note;
  for (const k of TIER_KEYS) {
    if ((a.floors[k] ?? null) !== (b.floors[k] ?? null)) d.floors = true;
    if (!sameOv(a.overrides[k], b.overrides[k])) d.overrides = true;
  }
  d.any = d.name || d.floors || d.overrides || d.note;
  return d;
}
export const sameDraft = (a, b) => !draftDiff(a, b).any;

/** 草稿 → 发给服务端的策略（新建时不带 id）。 */
export function strategyPayload(d) {
  const out = { name: clipName(d.name), floors: {}, overrides: {}, note: String(d.note || '').slice(0, NOTE_MAX) };
  if (d.id) out.id = d.id;
  for (const k of TIER_KEYS) {
    out.floors[k] = floorNum(d.floors[k]);
    const ov = d.overrides[k];
    out.overrides[k] = ov && ov.model ? { model: ov.model, effort: ov.effort || '' } : null;
  }
  return out;
}

export const hasFloorEdits = (d) => !!d && TIER_KEYS.some((k) => d.floors[k] != null);

/** 去首尾空白、压掉换行，按「字」截到 24（不把代理对劈开）。 */
export function clipName(s) {
  const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, NAME_MAX).join('').trim();
}

/** 不和现有名字撞的名字：make(n) 给出第 n 个候选（n 从 1 起），撞了就试下一个。 */
export function uniqueName(names, make) {
  const taken = new Set((names || []).map((n) => String(n)));
  for (let n = 1; n <= 99; n++) {
    const c = clipName(make(n));
    if (c && !taken.has(c)) return c;
  }
  return clipName(make(1));
}

// —— 策略名给人看的写法 ——
// 迁移时自动建的那一套，存下来的名字就是「默认」（契约 §2.1）：界面上跟着语言走；用户自己起的名字原样显示。
// 两套设置外壳的入口副标题是同一个判断（Settings.svelte / SettingsDesktop.svelte 里拼副标题的那两行），口径要保持一致。
const MIGRATED_NAME = '默认';   // i18n-ignore 与存下来的名字比较
/** def = 调用方给的 t('默认')（本文件不碰翻译层）。空名同样回 def；存盘、比较一律还用原名。 */
export function strategyLabel(name, def) {
  const s = String(name == null ? '' : name);
  return (!s || s === MIGRATED_NAME) && def != null ? String(def) : s;
}

// —— 模型写法 ——
// 策略里存规范写法：Claude 订阅模型 = 别名 opus / sonnet / haiku / fable，第三方 = custom:<服务 id>:<型号>。
// 模型菜单用的是 claude-* 全 id；别名只对应每个家族「当前那一个」（caps 的主列表，同服务端 CLAUDE_SUBS）。
export const isCustom = (id) => typeof id === 'string' && id.startsWith('custom:');
const FAMILY = /^claude-(opus|sonnet|haiku|fable)(?:-|$)/i;
export const familyOf = (id) => { const m = FAMILY.exec(String(id || '')); return m ? m[1].toLowerCase() : ''; };

/** 模型菜单里的 id → 规范写法；不是主列表里的 Claude 模型（旧型号没有别名）回 ''。 */
export function toCanonical(id, primary) {
  if (isCustom(id)) return id;
  return (primary || []).some((m) => m.id === id) ? familyOf(id) : '';
}
/** 规范写法 → 模型菜单里的 id；对不上回 ''。 */
export function toPickerId(model, primary) {
  const s = String(model || '');
  if (!s) return '';
  if (isCustom(s) || /^claude-/i.test(s)) return s;
  const hit = (primary || []).find((m) => familyOf(m.id) === s.toLowerCase());
  return hit ? hit.id : '';
}
/** 换模型后的推理强度：原来那档还在新模型的档位表里就留着，否则清空（= 用模型默认）。 */
export const keepEffort = (effort, table) => (effort && (table || []).some((e) => e.id === effort) ? effort : '');
/** 推理强度在一张档位表（[{ id, name }]，输入栏拉条面板用的那张）里叫什么；表里没有这一档回 ''。 */
export function effortLabelIn(table, effort) {
  const hit = (table || []).find((e) => e && e.id === (effort || ''));
  return (hit && hit.name) || '';
}

// —— 四档落点的本地预估 ——
// 服务端的预览（previewStrategy）要过一次防抖加一次往返；拖判定线、点「回到图谱」的那一下先按同一条规则
//（契约 §1）在本地算出来，线、落点行和图上的环才跟得上手。服务端的结果回来后以它为准。

/** 图谱规则（pickForFloor）：智力分 ≥ floor 的候选里成本最低的，成本相同取智力分更低的；都够不着 → 智力分最高的，标 short。
 *  为档位自定义合成出来的格子（est）不参与。 */
export function chartPick(cands, floor) {
  const real = (cands || []).filter((c) => c && !c.est);
  const hit = pickForFloor(real, floor);
  return hit ? { pick: real[hit.index], short: hit.short } : null;
}

/** 档位自定义：模型 + 推理强度都对上 → 那一格；只有模型对上 → 借它最近的一格、换上指定的推理强度（标 est）；模型不在候选里 → null。 */
export function overridePick(cands, ov) {
  if (!ov || !ov.model) return null;
  const mine = (cands || []).filter((c) => c && c.model === ov.model);
  if (!mine.length) return null;
  const exact = mine.find((c) => (c.effort || '') === (ov.effort || ''));
  if (exact) return exact;
  const base = mine.find((c) => !c.est) || mine[0];
  return { ...base, effort: ov.effort || '', est: true };
}

/**
 * 按草稿在本地排出四档：serverTiers 提供默认线与「普通子 agent」落点，candidates 是已配置的点。
 * 返回 [{ key, floor, floorDefault, pick, source, short, overrideSkipped, agentTool }]；没有候选或默认线时回 []。
 */
export function estimateTiers(serverTiers, candidates, draft) {
  const byKey = new Map((serverTiers || []).map((x) => [x.key, x]));
  const out = [];
  for (const k of TIER_KEYS) {
    const base = byKey.get(k);
    if (!base) continue;
    const floorDefault = Number.isFinite(base.floorDefault) ? base.floorDefault : base.floor;
    const mine = draft && draft.floors ? draft.floors[k] : null;
    const floor = mine != null ? mine : floorDefault;
    const ov = draft && draft.overrides ? draft.overrides[k] : null;
    const forced = overridePick(candidates, ov);
    if (forced) { out.push({ key: k, floor, floorDefault, pick: forced, source: 'override', short: false, overrideSkipped: false, agentTool: null }); continue; }
    const got = chartPick(candidates, floor);
    if (!got) continue;
    out.push({ key: k, floor, floorDefault, pick: got.pick, source: 'chart', short: got.short, overrideSkipped: !!ov, agentTool: null });
  }
  return out;
}

/**
 * 四档 → 交给性价比图的那份。落点要带全（智力分、成本、显示名、计费口径……）：档位自定义落在候选里没有的格子上时
 *（那一档没有评分，按相邻的档估出来的，标 est），图得靠这些数给它补一个虚点，环和档名签才有地方套——只给模型和推理强度的话，
 * 这一档在图上就什么都没有。服务端的落点不带 creator（图上按它分厂商配色）：从同一个模型的候选格上借。
 */
export function chartTiersOf(tiers, candidates) {
  const out = [];
  for (const x of tiers || []) {
    if (!x || !x.pick) continue;
    const p = x.pick;
    const creator = p.creator || ((candidates || []).find((c) => c && c.model === p.model && c.creator) || {}).creator || '';
    out.push({
      key: x.key, floor: x.floor, floorDefault: x.floorDefault, source: x.source, short: !!x.short,
      pick: { ...p, effort: p.effort || '', ...(creator ? { creator } : {}) },
    });
  }
  return out;
}

// —— 浮层 ——
/**
 * 触发片的视口矩形 → 浮层的锚点（收进视口里）。手机上软键盘一弹，视口矮了一截，片可能整个落在键盘底下：
 * 拿它原来的位置去摆，菜单也跟着摆到看不见的地方。收进来之后，片在视口下面 = 贴着视口底边朝上开，在上面 = 贴着顶边朝下开。
 */
export function anchorRect(rect, vw, vh) {
  const cx = (v) => Math.min(Math.max(Number(v) || 0, 0), Math.max(0, vw));
  const cy = (v) => Math.min(Math.max(Number(v) || 0, 0), Math.max(0, vh));
  const r = rect || {};
  return { left: cx(r.left), right: cx(r.right), top: cy(r.top), bottom: cy(r.bottom) };
}

/** 菜单里按 ↑ ↓ Home End 之后焦点落在第几项。i = 现在第几项（不在菜单里是 -1），n = 一共几项；别的键、空菜单回 -1。 */
export function menuStep(key, i, n) {
  if (!(n > 0)) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === 'ArrowDown') return i < 0 ? 0 : (i + 1) % n;
  if (key === 'ArrowUp') return i < 0 ? n - 1 : (i - 1 + n) % n;
  return -1;
}
/**
 * Tab 圈在浮层里。i = 焦点现在是层里第几个能聚焦的（不在层里是 -1），n = 一共几个，back = 按着 Shift。
 * 回要去的那一个；-1 = 不用管（层里相邻两个之间浏览器自己会走；n = 0 时没有地方可去）。
 */
export function tabStep(i, n, back) {
  if (!(n > 0)) return -1;
  if (i < 0) return back ? n - 1 : 0;
  if (!back && i === n - 1) return 0;
  if (back && i === 0) return n - 1;
  return -1;
}

// —— 防连点 ——
/**
 * 同一时刻只跑一趟：在途时再调，拿到的是同一个结果，不另起一趟。
 * （「有未保存的改动，要保存吗」那一问：连点策略签、点了签又点复制，都只问一轮。）
 */
export function sharedFlight(run) {
  let p = null;
  return function shared() {
    if (!p) p = (async () => run())().finally(() => { p = null; });
    return p;
  };
}
/**
 * 同一件事在途时再点不重复办：const once = singleFlight({ cool }); once(run)。
 * 在途、或上一次落定后 cool 毫秒之内（双击的第二下常常落在第一下已经办完之后）→ 不办，回 undefined；否则回 run() 的结果。
 */
export function singleFlight({ cool = 0, now = Date.now } = {}) {
  let busy = false, doneAt = -Infinity;
  return async function once(run) {
    if (busy || now() - doneAt < cool) return undefined;
    busy = true;
    try { return await run(); } finally { busy = false; doneAt = now(); }
  };
}
/**
 * 先过一道要等的关（gate() → 真 = 放行），再对「最后一次要的那个」动手（act(target)）。
 * 关还没过完时又要了别的：只把目标换成新的，不再过一遍关。go.busy() = 现在是不是正等在关上。
 */
export function latestAfter(gate, act) {
  let busy = false, want;
  async function go(target) {
    want = target;
    if (busy) return;
    busy = true;
    try { if (await gate()) act(want); } finally { busy = false; }
  }
  go.busy = () => busy;
  return go;
}

// —— 写法 ——
/** 导入时间：今年的写「11-09 14:05」，别的年份写「2025-11-09」。at 是毫秒数或能被 Date 认的字符串。 */
export function fmtWhen(at, now = Date.now()) {
  const d = new Date(typeof at === 'number' ? at : String(at || ''));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (d.getFullYear() !== new Date(now).getFullYear()) return `${d.getFullYear()}-${md}`;
  return `${md} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 拖进来 / 选中的文件像不像性价比图：'' = 可以导入；'type' = 不是 HTML；'size' = 超过上限；'empty' = 空文件。 */
export function chartFileProblem(file) {
  if (!file) return 'type';
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  if (!(/\.html?$/.test(name) || type === 'text/html')) return 'type';
  if (!(file.size > 0)) return 'empty';
  if (file.size > CHART_MAX_BYTES) return 'size';
  return '';
}
