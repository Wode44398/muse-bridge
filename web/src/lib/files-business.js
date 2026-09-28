export const SHARE_TTLS = Object.freeze([
  { h: 1, lb: '1小时' },
  { h: 24, lb: '1天' },
  { h: 24 * 7, lb: '7天' },
  { h: 24 * 30, lb: '30天' },
]);

export const AI_NAMES = Object.freeze({
  claude: 'Claude',
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
  if (dialog?.pwOn && !password) return { error: '请填写分享密码' };
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
  return result.pw ? `${result.url}\n分享密码：${result.pw}` : result.url;
}

export function formatShareExpiry(value) {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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

// 「发送给 AI」：把一份工作空间文件挂进 Claude 某个对话的输入栏。
//   selectedSession：'new' = 开新对话；会话 id = 先切过去；空 = 就挂在当前对话上。
//   material(item, direct) → 附件对象（direct=true：零拷贝直给源绝对路径，Claude 在服务器本机直读）。
export async function sendFileToAi(item, selectedSession, { material, toast, chat, navigate }) {
  toast('正在准备…');
  const attachment = await material(item, true);
  if (!attachment) return;
  if (selectedSession === 'new') chat.newChat();
  else if (selectedSession && selectedSession !== chat.current()) await chat.load(selectedSession);
  chat.attach(attachment);
  navigate('claude');
  toast('已加到对话输入，去问它吧');
}
