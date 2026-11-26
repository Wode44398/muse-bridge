// 工作空间（FilesPanel）的「上次看到的样子」：根目录列表、根目录补充元数据、电脑位置表。
//
// 冷启动后第一次进工作空间，页面推进来时内存缓存（window.__bridgeFilesListCache）还是空的，
// 只能先摆一屏空白等 /api/files；位置表（/api/project/locations 要枚举盘符，常比列表还慢）到了才长出顶栏的
// 位置胶囊，路径条那一行随之撤掉，整页往上跳一截。这里把三样小东西记进 lastKnown（localStorage，同步读），
// 推进来的第一帧就画上次的样子，网络回来原地换。
//
// 只记身份工作空间的根目录：进页默认落在这里，子目录点进去本来就隔一拍，记了也只是多占地方。
// 不走 lib/cache.js（IndexedDB）：那边异步读，冷开第一帧拿不到，正是要绕开的那一拍；
// 根目录一般几十项、几 KB，超过 MAX_ITEMS 的（有人把几千个文件堆在根上）干脆不记，退回等网络。
import { forget, recall, remember } from '../lastKnown.js';

const ROOT = 'files.root';
const ROOT_META = 'files.rootMeta';
const LOCS = 'files.locs';
const MAX_ITEMS = 400;

// FilesPanel 的 listKey 里「身份工作空间根目录」那一格：云端、没带 ws、相对路径为空
export const ROOT_LIST_KEY = 'cloud\x1f\x1f';

// 桌面壳的缩略图 dataUrl（native*）是本机现取的，又大，不进快照
const slim = (it) => {
  const o = {};
  for (const k in it) if (!k.startsWith('native')) o[k] = it[k];
  return o;
};

/** 上次的根目录：{ items, truncated, total }；没有 / 坏了回 null */
export function recallRoot() {
  const v = recall(ROOT);
  return v && Array.isArray(v.items) ? v : null;
}
export function rememberRoot(items, meta) {
  if (!Array.isArray(items)) return;
  // 太大的根目录不记，并把以前记的作废：留着它冷开会先画出一份早就对不上的旧列表
  if (items.length > MAX_ITEMS) { forget(ROOT); forget(ROOT_META); return; }
  remember(ROOT, { items: items.map(slim), truncated: !!meta?.truncated, total: meta?.total || 0 });
}
/** 根目录打不开了（没权限 / 不存在）：下次别再先画它 */
export function forgetRoot() { forget(ROOT); forget(ROOT_META); }

/** 根目录的补充元数据（文件夹项目数、视频时长、图片宽高）：图标视图格子下那行小字跟列表一起出 */
export function recallRootMeta() {
  const v = recall(ROOT_META);
  return v && typeof v === 'object' ? v : null;
}
export function rememberRootMeta(meta) {
  if (meta && typeof meta === 'object' && Object.keys(meta).length <= MAX_ITEMS) remember(ROOT_META, meta);
}

/** 上次的电脑位置表（已滤掉不在文件管理器里出现的那几条）；没有回 null */
export function recallLocs() {
  const v = recall(LOCS);
  return Array.isArray(v) && v.length ? v : null;
}
export function rememberLocs(list) {
  if (Array.isArray(list)) remember(LOCS, list.map((l) => ({ id: l.id, name: l.name, path: l.path })));
}
export function forgetLocs() { forget(LOCS); }
