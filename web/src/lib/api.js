// Thin REST client for the bridge backend. Paths are absolute (/api/...).
//
// Auth: in production the durable bridge_auth / bridge_user cookie carries the
// session, so we usually send nothing. An admin access token (when the user pasted
// one) is sent as a Bearer header. On the loopback NO_AUTH dev instance neither is
// needed. SSE chat streaming is handled separately in sse.js.

import { apiUrl, noteNetFail, noteServerReachable, noteServerUnreachable, confirmReachability } from './server.js';

// 网关类状态：源站（电脑）不可达时隧道/反代给的形态，fetch 不会 reject。
// bridge 自己也会用 502/503 表达子服务不可用，故不据此下结论，只触发 /healthz 二次确认。
const GATEWAY_DOWN = (s) => s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
import { storeGet, storeSet } from './store.js';
import { hasNativeWorkspace, nativeWorkspaceList } from './nativeDesktop.js';

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
    // 网络层失败：正走 LAN 就立刻失效切回隧道；用户主动取消不算网络故障。
    // 连 HTTP 响应都没拿到 = 服务器不可达 → 亮离线态（自愈重探见 server.js）。
    if (e?.name !== 'AbortError') { noteNetFail(); noteServerUnreachable(); }
    throw e;
  }
  // 拿到响应通常说明电脑还在 → 离线态立刻熄灭；但网关类 5xx 可能是隧道在替一台
  // 已经关机的电脑答话，那种不能算在线，交给 /healthz 裁决。
  // 状态码一并交过去：530 = Cloudflare 找不到这条隧道（临时地址时多半是地址换了），离线提示条据此换说法。
  if (GATEWAY_DOWN(res.status)) confirmReachability(res.status); else noteServerReachable();
  if (!res.ok) {
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

// 壁纸原图 / 深度图直传 raw body（XHR：真实进度 + 可靠超时，同 uploadBlob）。返回 {ok,item}
function wallpaperPost(path, blob, { onProgress, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(path));
    const h = authHeaders(); for (const k in h) xhr.setRequestHeader(k, h[k]);
    xhr.timeout = timeout;
    if (xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / Math.max(1, e.total)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('bad response')); } }
      else { noteNetFail(); reject(new Error('HTTP ' + xhr.status)); }
    };
    xhr.onerror = () => { noteNetFail(); reject(new Error('network error')); };
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send(blob);
  });
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
  // 比 fetch(blob) 可靠。认证沿用 authHeaders（离线 apk 靠 Bearer），返回 {path,name}。
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
      else { noteNetFail(); reject(new Error('HTTP ' + xhr.status)); }
    };
    xhr.onerror = () => { noteNetFail(); reject(new Error('network error')); };
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send(blob);
  }),

  // conversations
  // keep：侧栏组内翻页拿回来的老会话 id——服务端回 gone（其中已不在活跃列表里的），前端据此摘掉幽灵行
  // quick=2：认得「多条临时对话」（S1-6）。不带的是老前端，服务端只给它一只临时对话桶（见 routes/sessions.mjs）
  sessions: (keep) => req('GET', '/api/sessions?quick=2' + (keep && keep.length ? '&keep=' + encodeURIComponent(keep.join(',')) : '')),
  // fp：上次拿到的响应指纹。带上它，服务端在「transcript / 回滚锚点 / prefs 都没变」
  // 时只回一个几十字节的 {unchanged:true}，不再重传整份记录（见 routes/sessions.mjs）。
  session: (id, fp) => req('GET', '/api/session?id=' + encodeURIComponent(id) + (fp ? '&fp=' + encodeURIComponent(fp) : '')),
  deleteSession: (id) => req('POST', '/api/session/delete', { id }),
  exportSession: (id) => req('POST', '/api/session/export', { id }),
  // 检查点回滚：mode 'both'=文件+对话 | 'files'=仅文件
  claudeRewind: (sessionId, uuid, mode) => req('POST', '/api/claude/rewind', { sessionId, uuid, mode }),

  // 「位置」（agent 中立）：工作空间 + 主目录 + Dimensio Projects + 各盘符。新建项目选择器与
  // 手机工作空间的「电脑位置」共用。admin 拿全量，Pro 只拿自己的工作空间——授权边界与
  // authorizeProjectPath 同源。
  projectLocations: () => req('GET', '/api/project/locations'),

  // Claude 项目（路径制：项目=工作空间目录=会话 cwd，与 codex projects 同构）
  claudeProjects: () => req('GET', '/api/claude/projects?quick=2'),   // quick=2 同上：全部临时对话桶
  createClaudeProject: (name, path) => req('POST', '/api/claude/project/create', { name, path }),
  renameClaudeProject: (id, name) => req('POST', '/api/claude/project/rename', { id, name }),
  deleteClaudeProject: (id) => req('POST', '/api/claude/project/delete', { id }),
  // 会话收藏 / 自定义标题（服务端按账号存，跨设备）：{op:'star'|'title'|'merge', …} → { library }
  claudeLibrary: (op) => req('POST', '/api/claude/library', op),
  // 临时对话（服务端 claude-quick.mjs）：拿一只没用过的空桶开新的临时对话 → { project }
  newQuickChat: () => req('POST', '/api/claude/quick/new', {}),
  // 把某条临时对话（它所在的桶 id）存为工作空间；label = 显示名（对话标题），没有就用 base + 编号 → { project, quick }
  saveQuickChat: (id, base, label) => req('POST', '/api/claude/quick/save', { id, base, quick: 2, ...(label ? { label } : {}) }),
  // 继续保留：回收时钟从头算 → { id, expiresAt }
  keepQuickChat: (id) => req('POST', '/api/claude/quick/keep', { id }),
  // 临时对话回收站 → { items }；恢复 → { project }
  recycledQuickChats: () => req('GET', '/api/claude/quick/recycled'),
  restoreQuickChat: (id) => req('POST', '/api/claude/quick/restore', { id }),

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

  // —— 工作空间文件（per-user 沙箱根；admin=vault）——
  // 桌面客户端的默认工作空间直接走主进程预热索引：不经过 HTTP、不闪 loading，
  // 并由 fs.watch 主动失效。项目侧栏传了 ws（任意项目绝对路径）时仍走服务端权限边界。
  // opts.q：按名字在整个目录里筛（服务端先筛后截，上千项被截断的目录靠它找到后面的项）。
  files: (path, ws, opts) => {
    const q = opts?.q ? '&q=' + encodeURIComponent(opts.q) : '';
    const http = () => req('GET', '/api/files?path=' + encodeURIComponent(path || '') + wsQuery(ws) + q, null, opts);
    return !ws && !q && hasNativeWorkspace() ? nativeWorkspaceList(path).catch(http) : http();
  },
  mkdir: (path, name, ws) => req('POST', '/api/files/mkdir', wsBody({ path, name }, ws)),
  // 新建文本文件（只建不覆盖：同名已存在 → 409 'exists'）
  newFile: (path, name, ws, content = '') => req('POST', '/api/files/newfile', wsBody({ path, name, content }, ws)),
  renameFile: (path, name, ws) => req('POST', '/api/files/rename', wsBody({ path, name }, ws)),
  deleteFile: (path, ws) => req('POST', '/api/files/delete', wsBody({ path }, ws)),
  // 送进电脑的回收站（admin 的「电脑位置」用；可在电脑上还原）。一次可多项，
  // 返回 { ok, results:[{ path, ok, error? }] }；全部失败时 reject，e.body.error 是原因。
  trashFiles: (paths, ws) => req('POST', '/api/files/delete', wsBody({ paths, trash: true }, ws)),
  // dest=目标目录相对路径；fromWs=源作用域根（跨作用域拖放 / 跨电脑位置时给，'' 表示身份文件根），不给＝与 ws 同根
  moveFile: (path, dest, ws, fromWs) => req('POST', '/api/files/move', { ...wsBody({ path, dest }, ws), ...(fromWs != null ? { fromWs } : {}) }),
  copyFile: (path, dest, ws, fromWs) => req('POST', '/api/files/copy', { ...wsBody({ path, dest }, ws), ...(fromWs != null ? { fromWs } : {}) }),
  saveFile: (path, content, ws) => req('POST', '/api/file/save', wsBody({ path, content }, ws)),   // 覆盖写文本（编辑器保存）
  mdLinks: (path, ws) => req('GET', '/api/file/mdlinks?path=' + encodeURIComponent(path) + wsQuery(ws)),   // md 双链：出链解析+同目录树反向链接
  mdNames: (path, ws) => req('GET', '/api/file/mdnames?path=' + encodeURIComponent(path) + wsQuery(ws)),   // [[ 补全名单：笔记所在目录树里的 md + 附件 {names:[{name,path,md}],truncated}
  // 带写前校验的保存：baseHash=这次基于的磁盘原文指纹（lib/textmerge.js textHash），磁盘已被别处改过 → 409 + { current }
  saveFileGuarded: (path, content, ws, baseHash) => req('POST', '/api/file/save', wsBody({ path, content, baseHash }, ws)),

  fileToUpload: (path, copy = true, ws) => req('POST', '/api/files/to-upload', wsBody(copy ? { path } : { path, copy: false }, ws)),   // 工作空间文件 →「发送给 AI」素材（copy=false 零拷贝直给源路径，Claude 用；默认拷 uploads，Gemini/媒体用）
  extractFile: (path, ws) => req('POST', '/api/files/extract', wsBody({ path }, ws)),   // 服务端解压压缩包（WinRAR/bsdtar）→ 同目录同名文件夹，返回 {ok,name,path}
  // 服务端压缩（同一文件夹里的若干项 → 同目录存档）。opts = { format:'zip'|'7z'|'tar.gz'|'rar', level:'store'|'fast'|'normal'|'max', name }
  // 立即回 { job, name }；进度/结果用 compressStatus(job) 轮询 → { state:'running'|'done'|'error', name, path, error, bytes }
  compressFiles: (paths, opts, ws) => req('POST', '/api/files/compress', wsBody({ paths, ...(opts || {}) }, ws)),
  compressStatus: (job) => req('GET', '/api/files/compress?job=' + encodeURIComponent(job)),
  compressFormats: () => req('GET', '/api/files/compress?formats=1'),   // 这台电脑能压的格式 { formats:[…] }（rar 要装 WinRAR）
  // —— 分享链接（学 qq-bot：文件 → /s/ 直链；文件夹 → /w/ 只读分享空间）——
  // opts = { ttlHours, password? }；返回 { ok, path:'/s|w/<token>', url?, expiresAt, locked }
  shareLink: (path, opts, ws) => req('POST', '/api/share', wsBody({ path, ...(opts || {}) }, ws)),
  shareSpaceMint: (paths, opts, ws) => req('POST', '/api/share-space', wsBody({ paths, ...(opts || {}) }, ws)),
  // 读/下载用 fileUrl() 直接喂 <img>/<video>/fetch；上传分块见 FilesPanel（raw body）。

  // —— 上传壁纸：存工作空间「壁纸」文件夹；可随附深度图（有深度图才有空间壁纸）——
  wallpaperList: () => req('GET', '/api/wallpaper/list'),
  wallpaperDelete: (id) => req('POST', '/api/wallpaper/delete', { id }),
  wallpaperUpload: (name, sys, blob, opts) =>
    wallpaperPost(`/api/wallpaper/upload?sys=${sys === 'dark' ? 'dark' : 'light'}&name=${encodeURIComponent(name || 'image.jpg')}`, blob, opts),
  wallpaperDepth: (id, name, blob, opts) =>
    wallpaperPost(`/api/wallpaper/depth?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name || 'depth.png')}`, blob, opts),

  // —— ChatGPT (Codex CLI)：bridge 侧车历史 ——
  codexSessions: () => req('GET', '/api/codex/sessions'),
  codexStop: () => req('POST', '/api/codex/stop'),
  codexUsage: () => req('GET', '/api/codex/usage'),
  codexSession: (id) => req('GET', '/api/codex/session?id=' + encodeURIComponent(id)),
  deleteCodexSession: (id) => req('POST', '/api/codex/session/delete', { id }),
  codexProjects: () => req('GET', '/api/codex/projects'),
  createCodexProject: (name, path) => req('POST', '/api/codex/project/create', { name, path }),

  // —— Vertex (Gemini)：对话历史 + 媒体（图像/视频/语音/音乐）——
  vertexSessions: () => req('GET', '/api/vertex/sessions'),
  vertexSession: (id) => req('GET', '/api/vertex/session?id=' + encodeURIComponent(id)),
  deleteVertexSession: (id) => req('POST', '/api/vertex/session/delete', { id }),
  vertexImage: (b) => req('POST', '/api/vertex/image', b),   // 同步 JSON → {ok,id,url}
  vertexImageChat: (b) => req('POST', '/api/vertex/image-chat', b),   // 多轮对话式编辑 → {ok,id,url,sessionId}
  vertexImageChats: () => req('GET', '/api/vertex/image-chats'),             // 图像会话列表 → {sessions:[{id,coverId,title,count,mtime}]}
  vertexImageChatSession: (id) => req('GET', '/api/vertex/image-chat/session?id=' + encodeURIComponent(id)), // 还原整链 → {id,turns}
  deleteVertexImageChat: (id) => req('POST', '/api/vertex/image-chat/delete', { id }),   // 删整条图像会话
  vertexTTS: (b) => req('POST', '/api/vertex/tts', b),       // 同步 JSON → {ok,id,url}
  vertexMediaList: (kind) => req('GET', '/api/vertex/' + kind + 's'),       // images|videos|audios|musics
  deleteVertexMedia: (kind, id) => req('POST', '/api/vertex/' + kind + '/delete', { id }), // image|video|audio|music
  // 注：视频(Veo)/音乐(Lyria) 生成是 SSE 进度流，在 lib/vertexMedia 控制器里用 fetch 读流，不走 req()。
};
