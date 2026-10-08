// Thin REST client for the bridge backend. Paths are absolute (/api/...).
//
// Auth: in production the durable bridge_auth / bridge_user cookie carries the
// session, so we usually send nothing. An admin access token (when the user pasted
// one) is sent as a Bearer header. On the loopback NO_AUTH dev instance neither is
// needed. SSE chat streaming is handled separately in sse.js.

import { apiUrl, noteServerReachable, noteServerUnreachable, confirmReachability } from './server.js';

// 网关类状态：源站（服务器）不可达时隧道/反代给的形态，fetch 不会 reject。
// bridge 自己也会用 502/503 表达子服务不可用，故不据此下结论，只触发 /healthz 二次确认。
const GATEWAY_DOWN = (s) => s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
import { storeGet, storeSet } from './store.js';
import { noteApiFailure } from './feedback.svelte.js';

let token = storeGet('bridge-token');
const wsQuery = (ws) => ws ? '&ws=' + encodeURIComponent(ws) : '';
const wsBody = (body, ws) => ws ? { ...body, ws } : body;

export function setToken(t) {
  token = t || null;
  storeSet('bridge-token', token);
}
export function getToken() { return token; }

export function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

async function req(method, path, body, opts) {
  const headers = authHeaders();
  let payload = body;
  const isRaw = body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string';
  if (body != null && !isRaw) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(apiUrl(path), { method, headers, body: payload, credentials: 'same-origin', signal: opts && opts.signal }); }
  catch (e) {
    // 连 HTTP 响应都没拿到 = 服务器不可达 → 亮离线态（自愈重探见 server.js）；用户主动取消不算网络故障。
    if (e?.name !== 'AbortError') { noteServerUnreachable(); noteApiFailure(method, path, 0); }
    throw e;
  }
  // 拿到响应通常说明服务还在 → 离线态立刻熄灭；但网关类 5xx 可能是反代在替一个
  // 已经停掉的服务答话，那种不能算在线，交给 /healthz 裁决。
  if (GATEWAY_DOWN(res.status)) confirmReachability(); else noteServerReachable();
  if (!res.ok) {
    noteApiFailure(method, path, res.status);   // 问题反馈的操作轨迹（只记路径与状态码）
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    // body 只能读一次：先当文本收下，再试 JSON——后端不少错误是 text/plain 的中文说明
    // （如分享 413「分享内容过大…」），直接存成字符串让 toast 能透传，别只剩裸状态码。
    try {
      const t = await res.text();
      try { err.body = JSON.parse(t); } catch { if (t) err.body = t.slice(0, 200); }
    } catch {}
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b, opts) => req('POST', p, b, opts),

  // identity / capabilities / auth
  auth: () => req('GET', '/api/auth'),
  login: (body) => req('POST', '/api/login', body || {}),        // user {username,password}; admin 靠 Bearer header
  register: (body) => req('POST', '/api/register', body || {}),  // {username,password,password2,invite}
  logout: () => req('POST', '/api/logout'),
  capabilities: () => req('GET', '/api/capabilities'),
  upload: (name, dataBase64) => req('POST', '/api/upload', { name, dataBase64 }),  // ≤20MB 单发，返回 {path,name}
  // XHR 上传一个 Blob（raw body → /api/upload-chunk，单请求当整块写入，服务端流式落盘扛大文件）。
  // 用 XHR 而非 fetch：① upload.onprogress 给真实上行进度 ② timeout 可靠超时（弱网卡死会真报错，
  // 不像 fetch 无超时永挂、AbortController 又掐不断正在发 body 的请求）③ WebView 里 send(blob)
  // 比 fetch(blob) 可靠。认证沿用 authHeaders，返回 {path,name}。
  // 铸一个「挂载文件夹」的根目录，返回 {dirName, path, name}；随后每个文件带 fdir/frel 传进去。
  uploadFolderInit: (name) => req('POST', '/api/upload/folder', { name }),
  // fdir/frel：把文件落进 uploads/<fdir>/<frel>，保住原目录结构（Claude 才能按原样 Glob/Read）。
  uploadBlob: (name, blob, { onProgress, timeout = 120000, fdir = '', frel = '' } = {}) => new Promise((resolve, reject) => {
    const id = 'fb' + Math.random().toString(36).slice(2, 12);
    const xhr = new XMLHttpRequest();
    const folder = fdir && frel ? `&fdir=${encodeURIComponent(fdir)}&frel=${encodeURIComponent(frel)}` : '';
    xhr.open('POST', apiUrl(`/api/upload-chunk?id=${id}&last=1&name=${encodeURIComponent(name)}${folder}`));
    const h = authHeaders(); for (const k in h) xhr.setRequestHeader(k, h[k]);
    xhr.timeout = timeout;
    if (xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / Math.max(1, e.total)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('bad response')); } }
      else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send(blob);
  }),

  // conversations
  sessions: () => req('GET', '/api/sessions'),
  // fp：上次拿到的响应指纹。带上它，服务端在「transcript / 回滚锚点 / prefs 都没变」
  // 时只回一个几十字节的 {unchanged:true}，不再重传整份记录（见 routes/sessions.mjs）。
  session: (id, fp) => req('GET', '/api/session?id=' + encodeURIComponent(id) + (fp ? '&fp=' + encodeURIComponent(fp) : '')),
  deleteSession: (id) => req('POST', '/api/session/delete', { id }),
  exportSession: (id) => req('POST', '/api/session/export', { id }),
  // 检查点回滚：mode 'both'=文件+对话 | 'files'=仅文件
  claudeRewind: (sessionId, uuid, mode) => req('POST', '/api/claude/rewind', { sessionId, uuid, mode }),

  // 新建项目选择器的「位置」（agent 中立）：工作空间 + 主目录 + Dimensio Projects
  // + 各盘符。admin 拿全量，Pro 只拿自己的工作空间——授权边界与 authorizeProjectPath 同源。
  projectLocations: () => req('GET', '/api/project/locations'),

  // Claude 项目（路径制：项目=工作空间目录=会话 cwd）
  claudeProjects: () => req('GET', '/api/claude/projects'),
  createClaudeProject: (name, path) => req('POST', '/api/claude/project/create', { name, path }),
  renameClaudeProject: (id, name) => req('POST', '/api/claude/project/rename', { id, name }),
  deleteClaudeProject: (id) => req('POST', '/api/claude/project/delete', { id }),
  // 快照对话：换一只全新的一次性桶（=开一条全新快照），旧桶留盘不再列出
  newQuickChat: () => req('POST', '/api/claude/quick/new', {}),

  // live turn（多对话并发：status 可按会话取 context；stop 可点名停某一轮）
  status: (sessionId) => req('GET', '/api/status' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')),
  commands: () => req('GET', '/api/commands'),   // 斜杠命令表 {commands:[{name,description,argumentHint}], terminal:[], at}
  active: () => req('GET', '/api/active'),
  // release:true =「结束等待」（这一轮只是挂着等后台任务）：服务端以暂存 result 正常定局，
  // 不留「已中断」；没有挂起时服务端自动回落成硬停。
  stop: (sessionId, { release = false } = {}) => req('POST', '/api/stop',
    (sessionId || release) ? { ...(sessionId ? { sessionId } : {}), ...(release ? { release: true } : {}) } : undefined),
  answer: (qid, payload) => req('POST', '/api/answer', { qid, ...(payload || {}) }),
  // 单条停止后台任务（任务面板每行的 ⏹）：走这一轮活着的控制通道，轮已结束会 409
  stopTask: (sessionId, taskId) => req('POST', '/api/claude/task/stop', { sessionId, taskId }),

  // —— 工作区人机协同上行（uiReport.js 专用）：视图上报 + 截图/草稿应答 ——
  uiState: (payload) => req('POST', '/api/ui/state', payload),
  uiAnswer: (id, result) => req('POST', '/api/ui/answer', { id, result }),

  // routines
  routines: () => req('GET', '/api/routines'),
  createRoutine: (r) => req('POST', '/api/routines', r),
  updateRoutine: (r) => req('POST', '/api/routines/update', r),
  deleteRoutine: (id) => req('POST', '/api/routines/delete', { id }),
  runRoutine: (id) => req('POST', '/api/routines/run', { id }),

  // —— 工作空间文件（per-user 沙箱根；admin=数据目录）——
  files: (path, ws, opts) => req('GET', '/api/files?path=' + encodeURIComponent(path || '') + wsQuery(ws), null, opts),
  mkdir: (path, name, ws) => req('POST', '/api/files/mkdir', wsBody({ path, name }, ws)),
  renameFile: (path, name, ws) => req('POST', '/api/files/rename', wsBody({ path, name }, ws)),
  deleteFile: (path, ws) => req('POST', '/api/files/delete', wsBody({ path }, ws)),
  // dest=目标目录相对路径；fromWs=源作用域根（跨作用域拖放时给，'' 表示身份文件根），不给＝与 ws 同根
  moveFile: (path, dest, ws, fromWs) => req('POST', '/api/files/move', { ...wsBody({ path, dest }, ws), ...(fromWs != null ? { fromWs } : {}) }),
  copyFile: (path, dest, ws) => req('POST', '/api/files/copy', wsBody({ path, dest }, ws)),
  saveFile: (path, content, ws) => req('POST', '/api/file/save', wsBody({ path, content }, ws)),   // 覆盖写文本（编辑器保存）
  mdLinks: (path, ws) => req('GET', '/api/file/mdlinks?path=' + encodeURIComponent(path) + wsQuery(ws)),   // md 双链：出链解析+同目录树反向链接
  mdNames: (path, ws) => req('GET', '/api/file/mdnames?path=' + encodeURIComponent(path) + wsQuery(ws)),   // [[ 补全名单：笔记所在目录树里的 md + 附件 {names:[{name,path,md}],truncated}
  // 带写前校验的保存：baseHash=这次基于的磁盘原文指纹（lib/textmerge.js textHash），磁盘已被别处改过 → 409 + { current }
  saveFileGuarded: (path, content, ws, baseHash) => req('POST', '/api/file/save', wsBody({ path, content, baseHash }, ws)),

  fileToUpload: (path, copy = true, ws) => req('POST', '/api/files/to-upload', wsBody(copy ? { path } : { path, copy: false }, ws)),   // 工作空间文件 →「发送给 AI」素材（copy=false 零拷贝直给源路径；默认拷进 uploads）
  extractFile: (path, ws) => req('POST', '/api/files/extract', wsBody({ path }, ws)),   // 服务端解压压缩包（bsdtar）→ 同目录同名文件夹，返回 {ok,name,path}
  // —— 分享链接（学 qq-bot：文件 → /s/ 直链；文件夹 → /w/ 只读分享空间）——
  // opts = { ttlHours, password? }；返回 { ok, path:'/s|w/<token>', url?, expiresAt, locked }
  shareLink: (path, opts, ws) => req('POST', '/api/share', wsBody({ path, ...(opts || {}) }, ws)),
  shareSpaceMint: (paths, opts, ws) => req('POST', '/api/share-space', wsBody({ paths, ...(opts || {}) }, ws)),
  // 读/下载用 fileUrl() 直接喂 <img>/<video>/fetch；上传分块见 FilesPanel（raw body）。
};
