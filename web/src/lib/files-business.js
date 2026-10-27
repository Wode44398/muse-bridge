import { t, locale, isEn } from './i18n.js';

export const SHARE_TTLS = Object.freeze([
  { h: 1, lb: t('1小时') },
  { h: 24, lb: t('1天') },
  { h: 24 * 7, lb: t('7天') },
  { h: 24 * 30, lb: t('30天') },
]);

export const AI_NAMES = Object.freeze({
  claude: 'Claude',
  gemini: 'Gemini',
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

export function fileAiCapabilities(item, kindOf) {
  if (!item) return { gemini: false, video: false, image: false, audio: false, music: false, mode: null };
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const isImage = kind === 'img';
  const isText = kind === 'md' || kind === 'text';
  return {
    gemini: true,
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

export async function sendFileToAi(item, target, slot, selectedSession, {
  kindOf,
  material,
  readText,
  toast,
  chats,
  mediaState,
  ensureVideoModel,
  navigate,
}) {
  const kind = item.isDir ? 'dir' : kindOf(item.name);
  const isImage = kind === 'img';
  const isText = kind === 'md' || kind === 'text';

  const chat = chats[target];
  if (chat) {
    toast(t('正在准备…'));
    const attachment = await material(item, target !== 'gemini');
    if (!attachment) return;
    if (selectedSession === 'new') chat.newChat();
    else if (selectedSession && selectedSession !== chat.current()) await chat.load(selectedSession);
    chat.attach(attachment);
    navigate(target === 'claude' ? 'claude' : 'vertex');
    toast(t('已加到对话输入，去问它吧'));
    return;
  }

  if (isImage && (target === 'video' || target === 'image')) {
    toast(t('正在准备…'));
    const attachment = await material(item);
    if (!attachment?.url) {
      toast(t('准备失败'));
      return;
    }
    const draft = { path: attachment.path, url: attachment.url, name: attachment.name };
    if (target === 'video') {
      const targetSlot = slot || 'first';
      if (targetSlot === 'last' || targetSlot === 'ref') ensureVideoModel(targetSlot);
      mediaState.func = 'video';
      mediaState.videoSrcDraft = { ...draft, slot: targetSlot };
    } else {
      mediaState.func = 'image';
      if (/^imagen/.test(mediaState.imageModel || '')) mediaState.imageModel = '';
      mediaState.imageSrcDraft = draft;
    }
    navigate('vertex');
    toast(t('已挂为生成素材，可换模型/调参后点生成'));
    return;
  }

  if (isText) {
    toast(t('正在读取…'));
    const content = await readText(item);
    if (content == null) {
      toast(t('读取失败'));
      return;
    }
    if (target === 'video') {
      mediaState.func = 'video';
      mediaState.videoDraft = content;
    } else if (target === 'image') {
      mediaState.func = 'image';
      mediaState.imageDraft = content;
    } else if (target === 'audio') {
      mediaState.func = 'voice';
      mediaState.voiceDraft = content;
    } else if (target === 'music') {
      mediaState.func = 'music';
      mediaState.musicDraft = content;
    }
    navigate('vertex');
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
