// 「聊天快照」——share-space 的可写可聊版：铸一枚公开 token，任何人凭
// https://bridge.<域>/c/<token> 打开一个【阉割版 Claude 分页】（无侧栏、只有对话），在一个
// 完全隔离的临时工作空间（桶）里与 Claude 对话。链接即凭证，人人可聊。
//
//   POST /api/chat-snapshot   （正常 per-identity 鉴权，铸快照的人用自己的登录态调）
//        body { qq?, note? } → 建桶 chat-snapshots/<token>/，返回 { ok, token, path:'/c/<t>', url }
//   GET  /api/csnap/meta?ct=<token>  （公开）→ { status:'active'|'closed'|'expired'|'gone', ... }
//   GET  /c/<token>           （公开）→ 吐现有 SPA（前端据 /c/ 前缀进「快照聊天」模式）
//
//   聊天/SSE/历史/附件卡走【现有】接口（/api/chat、/api/attach、/api/session、/api/claude/
//   artifact…），凭 ?ct=<token> 解析成 kind:'snap' 身份——可写、cwd 锁死桶内、无 shell
//   （见 runtime/identity.mjs）。server.mjs 只把带 resolveSnap 的 identify 传给聊天相关的
//   路由模块，vertex/媒体/助手等其余端点拿不到 snap 身份，天然 401。
//
// 生命周期：最后一条【用户消息】起 1 小时无人发言 → 过期，扫描器删桶；Claude 判定恶意
// 使用可调 close_snapshot 工具（src/mcp/snapshot.mjs）关停——立即拒绝一切新请求，桶随后删除。

import path from 'node:path';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { requireCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { getLiveGens } from '../runtime/gen.mjs';
import { sessionsDir } from '../runtime/paths.mjs';
import { ROOT, PUBLIC_ORIGIN, PUBLIC_DIR } from '../config/index.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { pageLang } from './share-gate.mjs';

const SNAPS_DIR = path.join(ROOT, 'chat-snapshots');      // 各桶：chat-snapshots/<token>/
const STORE_FILE = path.join(ROOT, 'chat-snapshots.json'); // token -> 元数据
export const SNAP_IDLE_MS = 60 * 60 * 1000;  // 1 小时无用户消息 → 过期删桶
const MAX_ACTIVE = 10;                        // 同时最多几个活跃快照（防刷）
export const SNAP_MAX_TURNS = 4;              // 全部快照合计同时在跑的 Claude 轮上限（额度保护）

let store = load();
// S7 原型链防护：ct token 是公网可控输入，普通对象下标会命中 constructor 等原型属性。store 恒无原型。
// 函数声明（非 const 箭头）——load() 在模块顶部 `let store = load()` 处就被调用，早于本行。
function bare(o) { return Object.assign(Object.create(null), o); }
function load() { try { return bare(JSON.parse(readFileSync(STORE_FILE, 'utf8')) || {}); } catch { return bare({}); } }
function save() { try { const t = STORE_FILE + '.tmp'; writeFileSync(t, JSON.stringify(store)); renameSync(t, STORE_FILE); } catch { /* 软状态 */ } }

const bucketDir = (token) => path.join(SNAPS_DIR, token);
const snapKey = (token) => 'c:' + token;   // identity key（gen 归属 / 并发统计都认它）
const isIdleExpired = (rec) => Date.now() - (rec.lastTouch || rec.createdAt || 0) > SNAP_IDLE_MS;

// —— 供 identity 解析：ct -> { token, dir }。关停/过期/不存在一律 null（所有 API 即 401）。——
export function resolveSnapToken(ct) {
  if (!ct) return null;
  const token = String(ct);
  const rec = store[token];
  if (!rec || rec.closed || isIdleExpired(rec)) return null;
  return { token, dir: bucketDir(token) };
}

// 每条快照用户消息调一次（routes/chat.mjs 的 snap 分支）：续 1 小时倒计时。
export function touchSnap(token) {
  const rec = store[token];
  if (!rec) return;
  rec.lastTouch = Date.now();
  save();
}

// 该快照是否允许 Fable 5（铸快照时定死）。默认否——公开链接 + 最贵模型，
// 想放开的群在管理台单独开。routes/chat.mjs 据此把 fable5 请求降级（抓包硬发也拦得住）。
export function snapAllowsFable(token) {
  return !!store[token]?.fable5;
}

// Claude 的 close_snapshot 工具（src/mcp/snapshot.mjs）调：立即关停。
export function closeSnapshot(token, reason) {
  const rec = store[token];
  if (!rec || rec.closed) return false;
  rec.closed = true;
  rec.closedAt = Date.now();
  rec.closedReason = String(reason || '').slice(0, 200);
  save();
  console.log(`[csnap] ${token.slice(0, 8)} closed by Claude: ${rec.closedReason}`);
  return true;
}

// —— 扫描器：过期/已关停的快照删桶（正在跑的轮结束后下个周期再删，别撬 Windows 文件锁）。——
function sweep() {
  let changed = false;
  for (const [token, rec] of Object.entries(store)) {
    if (!rec.closed && !isIdleExpired(rec)) continue;
    if (getLiveGens(snapKey(token)).length) continue;   // 还有轮在跑：等它收尾
    try { rmSync(bucketDir(token), { recursive: true, force: true }); } catch { continue; }  // 删不动（文件锁）下轮再试
    delete store[token]; changed = true;
    console.log(`[csnap] ${token.slice(0, 8)} swept (${rec.closed ? 'closed' : 'idle-expired'})`);
  }
  if (changed) save();
}
setInterval(sweep, 5 * 60 * 1000).unref?.();

// 桶里最新的会话 id（transcript 落在 <桶>/.bridge/claude/projects/<slug>/）：快照页重开时
// 凭它加载历史。桶=单聊天室，取 mtime 最新的即「这个房间的对话」。
function newestSession(token) {
  const dir = bucketDir(token);
  const sess = sessionsDir(dir, path.join(dir, '.bridge', 'claude'));
  let best = null;
  try {
    for (const n of readdirSync(sess)) {
      if (!n.endsWith('.jsonl')) continue;
      let mt = 0; try { mt = statSync(path.join(sess, n)).mtimeMs; } catch {}
      if (!best || mt > best.mt) best = { id: n.slice(0, -6), mt };
    }
  } catch {}
  return best ? best.id : null;
}

const bad = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
const okJson = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// —— 关停/过期落地页（无 SPA，纯 HTML）——
const goneHtml = (title, sub) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#555;margin:0;background:#faf9f5"><div style="text-align:center;padding:24px"><h2 style="color:#222;font-weight:600">' + title + '</h2><p style="line-height:1.7">' + sub + '</p></div>';

function serveSnapApp(req, res, url) {
  const token = decodeURIComponent(url.pathname.slice(3));
  const rec = store[token];
  const page = (t, s) => { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(goneHtml(t, s)); };
  // 访客页语言见 share-gate.mjs pageLang（默认中文；浏览器语言里没有中文才出英文）。中文页原样不动。
  if (pageLang(req) === 'en') {
    const again = '<br>To start a new one, @mention the bot in the group and send /chat.';
    if (!rec) return page('Snapshot not found', 'This chat snapshot doesn’t exist or has been deleted.' + again);
    if (rec.closed) return page('Snapshot shut down', 'Claude determined this snapshot was being misused and shut it down.<br>' + (rec.closedReason ? 'Reason: ' + (rec.closedReason === '恶意使用' ? 'Malicious use' : rec.closedReason) : ''));
    if (isIdleExpired(rec)) return page('Snapshot expired', 'No new messages for over 1 hour, so this chat snapshot was deleted automatically.' + again);
  }
  if (!rec) return page('快照不存在', '这个对话快照不存在或已销毁。<br>在群里 @机器人 发送 /chat 可以新开一个。');
  if (rec.closed) return page('快照已被关停', 'Claude 判定该快照被恶意使用，已将其关停。<br>' + (rec.closedReason ? '原因：' + rec.closedReason : ''));
  if (isIdleExpired(rec)) return page('快照已过期', '超过 1 小时没有新消息，这个对话快照已自动销毁。<br>在群里 @机器人 发送 /chat 可以新开一个。');
  try {
    let html = readFileSync(path.join(PUBLIC_DIR, 'app', 'index.html'), 'utf8');
    const tag = `<script>window.__CAPS__=${JSON.stringify(CAPABILITIES)};</script>`;
    html = html.includes('<!-- CAPS_INJECT -->') ? html.replace('<!-- CAPS_INJECT -->', tag) : html.replace('</head>', tag + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('failed to serve page'); }
}

export function registerChatSnapshotRoutes(router, { identify }) {
  // 铸快照（有 canSnapshot 权限的登录身份）。走【不带 snap 解析】的 identify——快照身份自己不能再铸快照。
  router.on('POST', '/api/chat-snapshot', async (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    // 快照是公开链接、用主机额度跑 Claude：管理员随意，注册用户要有「可铸快照」权限（控制台按人开关；
    // 老账号保留、新注册默认没有）。Claude 关了也不许铸。
    if (!ctx.canSnapshot) return bad(res, 403, '这个账号没有铸聊天快照的权限');
    if (!ctx.allowClaude) return bad(res, 403, 'Claude 未启用');
    let body = {}; try { body = JSON.parse(await readBody(req) || '{}'); } catch { return bad(res, 400, 'bad json'); }
    const activeCount = Object.values(store).filter((r) => !r.closed && !isIdleExpired(r)).length;
    if (activeCount >= MAX_ACTIVE) return bad(res, 429, `同时最多 ${MAX_ACTIVE} 个活跃快照，稍后再试`);
    const token = crypto.randomBytes(16).toString('base64url');   // ~128bit
    try { mkdirSync(bucketDir(token), { recursive: true }); } catch { return bad(res, 500, '建桶失败'); }
    const now = Date.now();
    store[token] = {
      owner: ctx.key,
      qq: String(body.qq || '').slice(0, 20),
      note: String(body.note || '').slice(0, 120),
      // 分群设置：本桶的模型选择器是否附带 Fable 5（并放行其请求）。铸桶时定，默认否。
      fable5: body.fable5 === true,
      createdAt: now, lastTouch: now,
    };
    save();
    const rel = '/c/' + token;
    okJson(res, { ok: true, token, path: rel, url: PUBLIC_ORIGIN ? PUBLIC_ORIGIN + rel : null, idleMs: SNAP_IDLE_MS });
  });

  // 快照元数据（公开，前端进页先查；也可用来判断旧链接是否还活着）。
  router.on('GET', '/api/csnap/meta', (req, res, url) => {
    const token = String(url.searchParams.get('ct') || '');
    const rec = store[token];
    if (!rec) return okJson(res, { status: 'gone' });
    if (rec.closed) return okJson(res, { status: 'closed', reason: rec.closedReason || '' });
    if (isIdleExpired(rec)) return okJson(res, { status: 'expired' });
    okJson(res, {
      status: 'active',
      sessionId: newestSession(token),
      createdAt: rec.createdAt,
      idleDeadline: (rec.lastTouch || rec.createdAt) + SNAP_IDLE_MS,
      fable5: !!rec.fable5,   // 前端 SnapPage 据此决定模型选择器是否列出 Fable 5
    });
  });

  // /c/<token> 动态段：中间件按前缀接管（同 /w/ 的做法）。
  router.use((req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/c/') || url.pathname.length <= 3) return;
    serveSnapApp(req, res, url);
    return false;
  });
}
