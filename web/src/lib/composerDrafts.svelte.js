// Claude 输入栏草稿缓存：每个会话一份「没发出去的文字 + 附件」，切走、最小化、关窗口、
// 杀进程（apk 原生存储，见 store.js）都不丢；切回来原样还给你。会话之间互不继承。
//
// 键：会话 id；还没发第一条的新对话共用一份 'new'（新对话不是会话，选项目芯片换归属时
// 草稿跟着走）。快照访客页另起命名空间，同一台设备上的不同登录身份也各自隔离。
//
// 草稿的主人是本模块而不是某个 Composer：Claude 页有两个输入栏实例（空态 hero / 聊天态）交叉
// 淡入，过渡期两个同时在场。所以文字由用户正在打字的那个实例经 noteComposerText 上报，
// 本模块持有、落盘；切换会话时由本模块统一换（compose.attachments 本来就是全局的一份），
// 再 bump draftText.nonce 让在场的输入栏把新文字写进 DOM。
//
// 新对话发出第一条、服务端回了会话 id——这不是「切会话」，是同一段对话拿到了名字：
// chat.svelte.js 在赋 session.id 之前调 promoteComposerDraft，这里只改键、不换内容
// （否则 Claude 首轮在跑时你已经在输入栏里打的下一句会被清掉）。
//
// 上传中的附件切走：上传照跑，传完补进原会话的草稿；切回来时还没传完就带着进度圈回来。

import { untrack } from 'svelte';
import { session, compose, me } from './state.svelte.js';
import { storeGet, storeSet } from './store.js';
import { apiUrl } from './server.js';
import { getToken } from './api.js';
import { IS_CSNAP, CSNAP_TOKEN } from './csnap.js';

const PREFIX = 'bridge-cdraft:';
const INDEX = 'bridge-cdraft-index';
const MAX_DRAFTS = 60;                    // 只留最近 60 份（按最后修改时间）
const TTL = 30 * 24 * 3600 * 1000;        // 30 天没动过的草稿自动清
const TEXT_MAX = 200_000;                 // 单份文字上限（防误粘超大日志撑爆存储）
const SAVE_MS = 350;                      // 打字防抖；切会话 / 页面隐藏时立即落盘
const PARK_TTL = 30 * 60 * 1000;          // 切走时还在上传的附件，最多等它 30 分钟

// 输入栏订阅：nonce 变 = 把 text 写进输入框（换会话 / 别的窗口改了同一会话的草稿）
export const draftText = $state({ text: '', nonce: 0 });

const ns = () => (IS_CSNAP ? 'csnap:' + CSNAP_TOKEN + ':' : (me.user || '') + ':');
const keyNow = () => session.id || 'new';
const storeKey = (k) => PREFIX + ns() + k;

let started = false;
let curKey = null;
let curText = '';
let dirty = false;
let attsSnap = '[]';
let timer = 0;
let promoteTo = null;
let parked = [];          // [{ key, item, arr, at }]：切走时还在上传的附件（live 代理）
let parkTimer = 0;

// —— 附件：只存能复原的字段；图片的 blob: 预览换成服务端 uploads 副本的 1280 缩略图 ——
const UPLOAD_FILE_RE = /[\\/]uploads[\\/]([^\\/]+)$/;
const KEEP = ['local', 'count', 'note', 'quoteId'];
function slim(list) {
  const out = [];
  for (const a of list || []) {
    if (!a || a.pending || !a.path) continue;
    const o = { path: a.path, name: a.name, kind: a.kind };
    for (const k of KEEP) if (a[k] != null && a[k] !== '' && a[k] !== false) o[k] = a[k];
    if (a.url && !String(a.url).startsWith('blob:')) o.url = a.url;
    out.push(o);
  }
  return out;
}
function rawUrl(file) {
  const t = getToken();
  return apiUrl('/api/upload/raw?name=' + encodeURIComponent(file) + '&thumb=preview' + (t ? '&token=' + encodeURIComponent(t) : ''));
}
function revive(list) {
  return (list || []).map((a) => {
    let url = a.url || null;
    if (a.kind === 'image' && !a.local) {
      const f = (UPLOAD_FILE_RE.exec(a.path || '') || [])[1];
      if (f) url = rawUrl(f);   // 现算：token / 线路可能已经换过
    }
    return { ...a, url, pending: false };
  });
}

// —— 存储：每份草稿一个键 + 一份索引（键 → 最后修改时间），超量 / 过期按索引清 ——
function readIndex() { try { const v = JSON.parse(storeGet(INDEX) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeIndex(idx) { storeSet(INDEX, Object.keys(idx).length ? JSON.stringify(idx) : null); }
function read(key) {
  try {
    const v = storeGet(storeKey(key));
    if (!v) return null;
    const rec = JSON.parse(v);
    if (!rec || (rec.at && Date.now() - rec.at > TTL)) { write(key, '', []); return null; }
    return rec;
  } catch { return null; }
}
function write(key, text, atts) {
  const sk = storeKey(key);
  const empty = !String(text || '').trim() && !atts.length;
  const idx = readIndex();
  if (empty) { storeSet(sk, null); delete idx[sk]; writeIndex(idx); return; }
  const at = Date.now();
  storeSet(sk, JSON.stringify({ text: String(text).slice(0, TEXT_MAX), atts, at }));
  idx[sk] = at;
  const keys = Object.keys(idx).sort((a, b) => idx[b] - idx[a]);
  for (const [i, k] of keys.entries()) if (i >= MAX_DRAFTS || at - idx[k] > TTL) { storeSet(k, null); delete idx[k]; }
  writeIndex(idx);
}

function markDirty() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_MS);
}
// 把当前草稿（属于 curKey）落盘。compose.attachments 此刻仍是 curKey 的那份——切换时先 flush 再换。
export function flushComposerDraft() {
  clearTimeout(timer); timer = 0;
  if (!dirty || curKey == null) return;
  dirty = false;
  write(curKey, curText, slim(compose.attachments));
}
const flush = flushComposerDraft;

function load(key) {
  const rec = read(key);
  curKey = key;
  curText = rec ? String(rec.text || '') : '';
  dirty = false;
  // 这个会话切走时还没传完的附件：还在传的带着进度圈回来，刚传完、还没来得及并进存档的也一起回来
  //（上传失败被移除的不要）。之后的完成照常走附件快照 effect 落盘。
  const back = parked.filter((p) => p.key === key && p.arr.includes(p.item) && (p.item.pending || p.item.path)).map((p) => p.item);
  parked = parked.filter((p) => p.key !== key);
  const atts = [...revive(rec ? rec.atts : []), ...back];
  compose.attachments = atts;
  attsSnap = JSON.stringify(slim(compose.attachments));
  draftText.text = curText;
  draftText.nonce++;
}

function switchTo(key) {
  if (key === curKey) return;
  // 新对话拿到了会话 id：同一段对话，只换键（内容、在场附件一律不动）
  if (curKey === 'new' && key === promoteTo) {
    promoteTo = null;
    const text = curText, atts = slim(compose.attachments);
    write('new', '', []);
    curKey = key;
    for (const p of parked) if (p.key === 'new') p.key = key;
    if (text.trim() || atts.length) { dirty = true; flush(); }
    return;
  }
  promoteTo = null;
  flush();
  // 还在上传的附件先停放：上传照跑，传完补进原会话草稿
  const arr = compose.attachments;
  for (const item of arr) if (item && item.pending) parked.push({ key: curKey, item, arr, at: Date.now() });
  if (parked.length && !parkTimer) parkTimer = setInterval(pollParked, 1000);
  // 换掉的那批里已传完的图片：本地 blob 预览可以回收了（切回来用服务端缩略图）
  for (const a of arr) if (a && !a.pending && typeof a.url === 'string' && a.url.startsWith('blob:')) { try { URL.revokeObjectURL(a.url); } catch {} }
  load(key);
}

function pollParked() {
  const now = Date.now();
  const keep = [];
  for (const p of parked) {
    if (!p.arr.includes(p.item) || now - p.at > PARK_TTL) continue;   // 上传失败被移除 / 等太久：放弃
    if (p.item.pending) { keep.push(p); continue; }
    if (!p.item.path) continue;
    if (p.key === curKey) { compose.attachments.push(p.item); continue; }   // 切回来了才传完：直接放进输入栏
    // 原会话不在眼前：并进它存着的草稿
    const rec = read(p.key) || { text: '', atts: [] };
    write(p.key, rec.text || '', [...(rec.atts || []), ...slim([p.item])]);
  }
  parked = keep;
  if (!parked.length) { clearInterval(parkTimer); parkTimer = 0; }
}

// 监听会话键与附件。【必须在模块顶层建 root】：在组件初始化里调 $effect.root，root 会挂在那个
// 组件的 effect 树下（create_effect 取 active_effect 当 parent），实测此后两个 effect 只在挂载时
// 跑一次、附件怎么变都不再重跑——草稿存了字、附件全丢。模块求值时没有 active_effect，这里建的
// 是真正独立的 root。开始工作（started）之前只登记依赖、什么都不做。
if (typeof window !== 'undefined') {
  $effect.root(() => {
    $effect(() => { const k = keyNow(); if (started) untrack(() => switchTo(k)); });
    // 附件增删、上传完成（pending→false、path 落定）都会改快照
    $effect(() => {
      const snap = JSON.stringify(slim(compose.attachments));
      if (started) untrack(() => { if (snap !== attsSnap) { attsSnap = snap; markDirty(); } });
    });
  });
}

// 输入栏打字上报（只有用户在那个实例里改了字才调；本模块写回 DOM 不算）
export function noteComposerText(text) {
  if (!started) return;
  const t = String(text ?? '').replace(/ /g, ' ');
  if (t === curText) return;
  curText = t;
  markDirty();
}

// chat.svelte.js：新对话首轮拿到会话 id、赋给 session.id 之前调
export function promoteComposerDraft(id) {
  if (id && !session.id) promoteTo = id;
}

// 切会话的地方（newConversation / loadSession / openRun）赋完 session.id 立刻同步调：
// 有些调用方紧接着就往输入栏塞附件（文件页「发送给 AI → 新对话」是 newConversation() 后同步
// attach）。等 effect 下一拍再换，那份附件会被当成上一个会话的草稿带走。effect 只兜底其余写法。
export function syncComposerDraftKey() {
  if (started) switchTo(keyNow());
}

export function startComposerDrafts() {
  if (started) return;
  started = true;
  // 输入栏第一次挂载前就被塞进来的附件（Claude 页还没打开过时从文件页「发送给 AI」）属于当前会话：
  // 读出存档后并回去，不能被存档覆盖掉
  const pre = [...compose.attachments];
  load(keyNow());
  for (const a of pre) if (!compose.attachments.some((x) => x === a || (a.path && x.path === a.path))) compose.attachments.push(a);
  if (typeof window !== 'undefined') {
    // 最小化 / 切 App / 关窗口：立即落盘，不等防抖
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    // 另一个窗口（分屏另一格、另开的窗）改了同一会话的草稿：这边没在改就跟上
    window.addEventListener('storage', (e) => {
      if (!curKey || e.key !== storeKey(curKey) || dirty) return;
      load(curKey);
    });
  }
}
