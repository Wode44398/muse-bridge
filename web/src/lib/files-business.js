import { t, locale, isEn } from './i18n.js';

export const SHARE_TTLS = Object.freeze([
  { h: 1, lb: t('1小时') },
  { h: 24, lb: t('1天') },
  { h: 24 * 7, lb: t('7天') },
  { h: 24 * 30, lb: t('30天') },
]);

export const AI_NAMES = Object.freeze({
  claude: 'Claude',
  agy: 'Antigravity',
});

export function normalizeFileQuery(value) {
  return String(value || '').trim().toLowerCase();
}

export function filterFilesByName(items, query) {
  const needle = normalizeFileQuery(query);
  return needle ? items.filter((item) => String(item?.name || '').toLowerCase().includes(needle)) : items;
}

export function shareRequest(dialog) {
  const password = dialog?.pwOn ? String(dialog.password || '').trim() : '';
  if (dialog?.pwOn && !password) return { error: t('请填写分享密码') };
  return {
    password,
    options: {
      ttlHours: Number(dialog?.ttl) || 24,
      ...(password ? { password } : {}),
    },
  };
}

export function shareResult(result, password, origin = location.origin) {
  return {
    url: result.url || origin + result.path,
    expiresAt: result.expiresAt,
    pw: password,
  };
}

export function shareClipboardText(result) {
  if (!result) return '';
  return result.pw ? t('{url}\n分享密码：{pw}', { url: result.url, pw: result.pw }) : result.url;
}

// zh-CN 输出与原先手拼的「9月28日 09:05」逐字一致；英文 en-US 12 小时制（Sep 28, 9:05 PM）。
export function formatShareExpiry(value) {
  const hm = isEn() ? { hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', ...hm }).format(new Date(value));
}

// kindOf 可以给旧码（img / md / text）也可以给 fileKinds 的码（image / md / markdown / text / code）
const isImageKind = (k) => k === 'img' || k === 'image';
const isTextKind = (k) => k === 'md' || k === 'markdown' || k === 'text' || k === 'code';

export function fileAiCapabilities(item, kindOf) {
  if (!item) return { video: false, image: false, audio: false, music: false, mode: null };
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const isImage = isImageKind(kind);
  const isText = isTextKind(kind);
  return {
    video: isImage || isText,
    image: isImage || isText,
    audio: isText,
    music: isText,
    mode: isImage ? 'image' : (isText ? 'text' : 'file'),
  };
}

export function filterAiSessions(sessions, query, titleForSession) {
  const needle = normalizeFileQuery(query);
  return needle
    ? sessions.filter((session) => normalizeFileQuery(titleForSession(session)).includes(needle))
    : sessions;
}

export async function loadAiSessions(target, {
  cached,
  remote,
  current,
  onCached,
  onDone,
}) {
  try {
    const sessions = await cached(target);
    if (sessions?.length && current()) onCached(sessions);
  } catch {}
  try {
    const result = await remote(target);
    if (current()) onDone(result?.sessions || []);
  } catch {
    if (current()) onDone(null);
  }
}

// 「发送给 AI」：对话类目标（Claude）挂进输入栏；媒体目标（video / image / audio / music）发到 Media Studio——
// 打开对应创作页并带上素材（图片当改图素材或视频首尾帧 / 参考图，文本填进输入岛）。经 studio.push 交给
// lib/state.svelte.js 的 studioInbox，核心不碰 studio 扩展的代码。
const STUDIO_PAGE = { video: 'video', image: 'image', audio: 'voice', music: 'music' };

export async function sendFileToAi(item, target, slot, selectedSession, {
  kindOf,
  material,
  readText,
  toast,
  chats,
  studio,
  navigate,
}) {
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const isImage = isImageKind(kind);
  const isText = isTextKind(kind);

  const chat = chats[target];
  if (chat) {
    toast(t('正在准备…'));
    const attachment = await material(item, target === 'claude');
    if (!attachment) return;
    if (selectedSession === 'new') chat.newChat();
    else if (selectedSession && selectedSession !== chat.current()) await chat.load(selectedSession);
    chat.attach(attachment);
    navigate(target);
    toast(t('已加到对话输入，去问它吧'));
    return;
  }

  const page = STUDIO_PAGE[target];
  if (isImage && (target === 'video' || target === 'image')) {
    toast(t('正在准备…'));
    const attachment = await material(item);
    if (!attachment?.url) {
      toast(t('准备失败'));
      return;
    }
    const role = target === 'video' ? (slot || 'first') : 'edit';
    studio.push({ page, input: { role, upload: attachment.path, url: attachment.url, name: attachment.name, kind: 'image' } });
    navigate('studio');
    toast(t('已挂为生成素材，可换模型/调参后点生成'));
    return;
  }

  if (isText && page) {
    toast(t('正在读取…'));
    const content = await readText(item);
    if (content == null) {
      toast(t('读取失败'));
      return;
    }
    studio.push({ page, text: content });
    navigate('studio');
    toast(t('内容已填入提示词栏'));
    return;
  }

  toast(t('该文件不支持发给这个目标'));
}

// —— 新建 Markdown ——
// 默认名与 Obsidian 同款：「未命名.md」，重名依次「未命名 1.md」「未命名 2.md」…（names＝当前目录已有的名字）
export function untitledMdName(names) {
  const taken = new Set([...(names || [])].map((n) => String(n).toLowerCase()));
  const base = t('未命名');
  let name = base + '.md';
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base} ${i}.md`;
  return name;
}
// 用户输入的名字补 .md：已带 md/markdown/txt 等文本扩展名的保留原样
export function withMdExt(name) {
  const s = String(name || '').trim();
  return /\.(md|markdown|txt)$/i.test(s) ? s : s + '.md';
}

// —— 压缩（内置选项：手机 / 网页 / 桌面壳以外的电脑）——
export const COMPRESS_FORMATS = Object.freeze([
  { value: 'zip', label: 'ZIP', ext: '.zip' },
  { value: '7z', label: '7Z', ext: '.7z' },
  { value: 'tar.gz', label: 'TAR.GZ', ext: '.tar.gz' },
  { value: 'rar', label: 'RAR', ext: '.rar' },
]);
export const COMPRESS_LEVELS = Object.freeze([
  { value: 'store', lb: t('仅存储') },
  { value: 'fast', lb: t('快速') },
  { value: 'normal', lb: t('标准') },
  { value: 'max', lb: t('最小体积') },
]);
// 服务端能压的格式（rar 要电脑装了 WinRAR）：拿一次缓存住，拿不到按不含 rar 算
let formatsCache = null;
export function loadCompressFormats(api) {
  formatsCache ||= api.compressFormats().then((r) => r?.formats || ['zip', '7z', 'tar.gz']).catch(() => { formatsCache = null; return ['zip', '7z', 'tar.gz']; });
  return formatsCache;
}
// 存档默认名：单项＝文件去扩展名 / 文件夹原名；多项＝所在文件夹名
export function compressDefaultName(items, dirName) {
  if (items.length !== 1) return dirName || 'archive';
  const it = items[0];
  return it.isDir ? it.name : String(it.name).replace(/\.(tar\.)?[^.]+$/i, '') || it.name;
}
// 提交并等完：POST 立即回 job，之后每 1.2s 轮询；onTick({ bytes, elapsed }) 给进度文案用。
// 服务端在跑的任务不随页面关闭取消——用户离开了，存档照样写完落在原目录。
export async function runCompress(api, rels, opts, ws, { onTick = null, signal = null } = {}) {
  const start = await api.compressFiles(rels, opts, ws);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (signal?.aborted) return { state: 'detached', name: start.name };
    let st;
    try { st = await api.compressStatus(start.job); }
    catch (e) { if (e?.status === 404) throw new Error(t('压缩任务丢失（服务可能重启过）')); continue; }   // 网络抖一下：接着等
    if (st.state === 'done') return st;
    if (st.state === 'error') throw new Error(st.error || t('压缩失败'));
    onTick?.(st);
  }
}

// —— 排序（手机 FilesPanel / 电脑 FilesDesktop / 服务端列表同一套规则，画廊顺序与列表一致）——
// 文件夹恒置顶（不随升降序翻转，同 Finder / 资源管理器）；名称用自然排序（「图2」排在「图10」前，
// 不分大小写）；其余键相同时回落按名称升序，保证顺序稳定、两端一致。
export const SORT_KEYS = Object.freeze(['name', 'mtime', 'size', 'type']);
// 新选一个键时的缺省方向：名称 / 类型升序，时间 / 大小降序（最新、最大的在前，同 Finder）
export const SORT_DEFAULT_DIR = Object.freeze({ name: 1, mtime: -1, size: -1, type: 1 });
const collators = new Map();
export function nameCollator(loc) {
  const key = loc || '';
  let c = collators.get(key);
  if (!c) {
    try { c = new Intl.Collator(loc || undefined, { numeric: true, sensitivity: 'base' }); }
    catch { c = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); }
    collators.set(key, c);
  }
  return c;
}
export function normalizeSort(value, fallback = { key: 'name', dir: 1 }) {
  const key = SORT_KEYS.includes(value?.key) ? value.key : fallback.key;
  const dir = value?.dir === -1 || value?.dir === 1 ? value.dir : (SORT_KEYS.includes(value?.key) ? SORT_DEFAULT_DIR[key] : fallback.dir);
  return { key, dir };
}
// 点同一个键＝反向；换键＝该键的缺省方向
export function nextSort(cur, key) {
  if (!SORT_KEYS.includes(key)) return normalizeSort(cur);
  return cur?.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: SORT_DEFAULT_DIR[key] };
}
// typeOf(item) → 类型排序键（缺省＝扩展名）；dirSize(item) → 文件夹大小（有的话参与大小排序）
export function makeFileComparator({ key = 'name', dir = 1, locale: loc, typeOf, dirSize } = {}) {
  const col = nameCollator(loc);
  const byName = (a, b) => col.compare(String(a?.name ?? ''), String(b?.name ?? '')) || (String(a?.name) < String(b?.name) ? -1 : String(a?.name) > String(b?.name) ? 1 : 0);
  const extKey = (it) => {
    const s = String(it?.name || '');
    const i = s.lastIndexOf('.');
    return i > 0 ? s.slice(i + 1).toLowerCase() : '';
  };
  const typeKey = typeOf || extKey;
  const sizeOf = (it) => (it?.isDir ? (dirSize ? dirSize(it) : null) : it?.size);
  return (a, b) => {
    const da = a?.isDir ? 1 : 0, db = b?.isDir ? 1 : 0;
    if (da !== db) return db - da;
    let r = 0;
    if (key === 'mtime') r = (Number(a?.mtime) || 0) - (Number(b?.mtime) || 0);
    else if (key === 'size') {
      const sa = sizeOf(a), sb = sizeOf(b);
      // 没有大小的（文件夹没算过）排在有大小的后面，不随方向翻转
      if (sa == null || sb == null) r = sa == null && sb == null ? 0 : (sa == null ? 1 : -1) * dir;
      else r = sa - sb;
    } else if (key === 'type') r = col.compare(String(typeKey(a) || ''), String(typeKey(b) || ''));
    else r = byName(a, b);
    if (r) return r * dir;
    return byName(a, b);
  };
}
export function sortFiles(list, opts) {
  return [...(list || [])].sort(makeFileComparator(opts));
}
