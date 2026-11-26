// 作品墙的纯函数（media.svelte.js 用；有单测）：作品并进列表、墙上要画的任务、按作品找回模型、侧列设置的读取。
import { pageOf } from './kinds.js';

/** 创作页 → 作品的 kind（配音页的作品在媒体库里叫 audio） */
export const PAGE_ASSET_KIND = { image: 'image', video: 'video', voice: 'audio', music: 'music' };
export const newWall = () => ({ items: [], cursor: null, done: false, loading: false, err: '', loaded: false });

const ts = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);

/**
 * 把新作品按时间（新 → 旧）插进已有列表，原地改 items；回插进去的个数。
 * 比列表最后一项还旧、而列表还没翻到底的不插：它在后面的页里，翻页时自然会来（对账拉回来的旧任务结果别顶到最前面）。
 */
export function mergeAssets(items, list, { gone, done = false, accept } = {}) {
  let n = 0;
  for (const a of list || []) {
    if (!a?.id || gone?.has(a.id) || (accept && !accept(a)) || items.some((x) => x.id === a.id)) continue;
    const at = ts(a.createdAt);
    let i = items.findIndex((x) => ts(x.createdAt) < at);
    if (i < 0) {
      if (items.length && !done) continue;
      i = items.length;
    }
    items.splice(i, 0, a);
    n++;
  }
  return n;
}

/** 翻页拿回来的接在后面（按 id 去重） */
export function appendAssets(items, list, gone) {
  for (const a of list || []) if (a?.id && !gone?.has(a.id) && !items.some((x) => x.id === a.id)) items.push(a);
}

/**
 * 重新拉第一页时：服务端这一页为准，再把本地已有、比这一页第一项还新的（拉取途中刚完成的任务结果）留在最前面。
 */
export function resetWallItems(current, fresh, gone) {
  const head = fresh.find((x) => !gone?.has(x.id));
  const top = head ? ts(head.createdAt) : -Infinity;
  const keep = (current || []).filter((x) => ts(x.createdAt) > top && !fresh.some((y) => y.id === x.id) && !gone?.has(x.id));
  return [...keep, ...fresh.filter((x) => !gone?.has(x.id))];
}

const isActive = (j) => j && (j.state === 'queued' || j.state === 'running');

/**
 * 这一页墙上要画的任务：在跑的（不管谁发起），加上本页面亲眼看着失败、还没收起的；新的在前。
 * 视频任务的尾帧图这类跨种类的结果不影响：按任务的 kind 归页。
 */
export function pickWallJobs(jobs, page) {
  return (jobs || [])
    .filter((j) => pageOf(j.kind) === page && (isActive(j) || (j.state === 'error' && j._failSeen && !j._dismissed)))
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
}

/** 作品记下的模型 → 目录里的模型：先按「服务/模型」，再按裸 id，再去掉厂商前缀比（旧作品的 provider 是方言名对不上） */
export function matchModel(models, a) {
  const bare = (s) => String(s || '').replace(/^[\w.-]+\//, '');
  const key = a?.provider ? a.provider + '/' + a.model : '';
  return (key && models.find((x) => x.key === key)) || models.find((x) => x.id === a?.model) || models.find((x) => bare(x.id) === bare(a?.model)) || null;
}

/** 一件作品属于哪一页 */
export const assetPage = (a) => pageOf(a?.kind);

/**
 * 侧列设置。pinned 的意思变了（以前是「侧栏常驻」默认开，现在是「侧列展开成墙」默认收），所以换了存储键；
 * 旧键里只搬宽度、分段、参数坞，旧的 pinned 不搬，免得老用户一进来侧列就是展开的。
 */
export function parseSide(rawNew, rawOld) {
  let o = null, migrated = false;
  try { o = rawNew ? JSON.parse(rawNew) : null; } catch {}
  if (!o || typeof o !== 'object') {
    try { o = rawOld ? JSON.parse(rawOld) : null; } catch {}
    migrated = true;
  }
  o = o && typeof o === 'object' ? o : {};
  return {
    width: Math.min(400, Math.max(240, Number(o.width) || 272)),
    pinned: !migrated && o.pinned === true,
    tab: o.tab === 'files' ? 'files' : 'works',
    dock: o.dock !== false,
  };
}
