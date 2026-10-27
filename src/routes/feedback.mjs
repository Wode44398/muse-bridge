// 用户反馈端点：手机 app / 网页 / 桌面（设置→提交反馈）POST 一条反馈 → 写成一个 markdown 落到这台服务器的
// 反馈库（默认在数据根 feedback/reports，可用 config.feedbackDir 改到工作空间；见 runtime/feedback-upstream.mjs 的
// FEEDBACK_DIR），Obsidian 与 AI(Claude) 都能直接读。
// 每条一个 .md（frontmatter 元数据 + 用户原话正文 + 可选图片/视频附件）。
//
// 附件：前端先经 /api/upload(-chunk) 把图片/视频传到 caller 自己的 uploads，提交时把返回的
// path 列表带过来；这里严格校验每个 path 落在 caller 的 uploads 内（防越权读任意文件），再
// copy 进反馈库 attachments/，正文用 ![[attachments/...]] 嵌入，obsidian 直接显示。
//
// 不分 admin/user 沙箱——所有反馈都汇到这台服务器的同一个反馈库，只把「谁提交的」记进 frontmatter。
// 默认不往外发。只有开服管理员主动打开了「把用户反馈同时发给 bridge 开发者」（config.feedbackUpstream=true），
// 并且提交人在提交页自己勾了「这条也发给 bridge 开发者」，落库之后才经反馈中继发出去（白名单字段，不带用户名）；
// bridge 开发者那台定时把外部反馈收进同一个库。见 runtime/feedback-upstream.mjs。
//   GET  /api/feedback/upstream   登录身份：当前角色（push / off / inbox），提交界面据此决定出不出「这条也发给开发者」勾选
//   POST /api/feedback/upstream   管理员：{ enabled } 开关推送（默认关；没配中继地址时打开回 400）
//   POST /api/feedback 的 shareWithDeveloper：提交人勾选同意（默认不勾）。不带的（没勾、旧版界面）只落本机——
//     旧字段 upstreamNotice 只表示「界面上写了去向」，不算同意，不再认
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { APP_VERSION_NAME, APP_VERSION_CODE } from '../config/versions.mjs';
import { feedbackUpstream, FEEDBACK_DIR, yamlStr, safeName, noteStamp } from '../runtime/feedback-upstream.mjs';

const sendJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// upstream / feedbackDir 只给测试注入（假中继、临时目录）；正式服用默认的那份
export function registerFeedbackRoutes(router, { identify, upstream = feedbackUpstream(), feedbackDir = FEEDBACK_DIR }) {
  const ATTACH_DIR = path.join(feedbackDir, 'attachments');
  // share = 公开分享链接的匿名访客——反馈直接落服务器的库，不能开放给持链接的任何人。
  const who = (req, res) => {
    const id = identify(req);
    if (!id || id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
    return id;
  };

  router.on('POST', '/api/feedback', async (req, res) => {
    const id = who(req, res); if (!id) return;
    const ctx = contextFor(id);

    let parsed; try { parsed = JSON.parse(await readBody(req)); } catch { parsed = {}; }
    const text = String(parsed.text ?? '').trim().slice(0, 8000);
    const atts = Array.isArray(parsed.attachments) ? parsed.attachments.slice(0, 9) : [];
    if (!text && !atts.length) { sendJson(res, 400, { ok: false, error: 'empty' }); return; }
    const screen = String(parsed.screen ?? '').slice(0, 120);

    const user = id.user || (id.kind === 'admin' ? 'admin' : '匿名');
    const tier = id.tier || (id.kind === 'admin' ? 'admin' : '');
    const { date, stamp } = noteStamp(new Date());   // 服务器本地时区（GMT+8）
    const safeWho = safeName(user).slice(0, 40);

    // 附件：只接 caller 自己 uploads 内的 path（严格前缀校验），copy 进反馈库 attachments/。
    const upBase = path.resolve(ctx.uploads);
    const embeds = [];
    const srcs = [];
    let ai = 0;
    for (const a of atts) {
      try {
        const src = path.resolve(String((a && a.path) || ''));
        if (src !== upBase && !src.startsWith(upBase + path.sep)) continue;   // 必须在自己的 uploads 内
        if (!existsSync(src) || !statSync(src).isFile()) continue;
        mkdirSync(ATTACH_DIR, { recursive: true });
        const fname = `${stamp}-${ai++}-${safeName((a && a.name) || path.basename(src))}`;
        copyFileSync(src, path.join(ATTACH_DIR, fname));
        embeds.push(`![[attachments/${fname}]]`);
        srcs.push(src);
      } catch {}
    }

    const fm = `---\ntype: feedback\ndate: ${date}\nuser: ${yamlStr(user)}\nkind: ${id.kind}\ntier: ${tier}\napp: v${APP_VERSION_NAME} (code ${APP_VERSION_CODE})\nscreen: ${yamlStr(screen || '-')}\nstatus: new\n---\n\n`;
    let md = fm + (text || '');
    if (embeds.length) md += (text ? '\n\n' : '') + '**附件：**\n' + embeds.join('\n');
    md += '\n';
    try {
      mkdirSync(feedbackDir, { recursive: true });
      writeFileSync(path.join(feedbackDir, `${stamp}-${safeWho}.md`), md, 'utf8');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); return;
    }
    // 本机那份写好了才往外推；推送只是放进待发队列，出任何问题都不影响这次提交。
    // shareWithDeveloper：提交人在提交页上自己勾了「这条也发给 bridge 开发者」（默认不勾，勾选处写明发什么、图片原样发出）。
    // 只认严格的 true：没勾、旧版界面（含界面打包在 apk 里的旧版离线 apk）都不带它——只落本机、不推
    const consent = parsed.shareWithDeveloper === true;
    let up = 'off';
    try { up = upstream.submit({ text, screen, role: id.kind === 'admin' ? 'admin' : 'user', user: id.user || '', lang: parsed.lang, files: srcs, consent }); }
    catch (e) { console.error('[feedback] 推送排队失败：' + ((e && e.message) || e)); }
    sendJson(res, 200, { ok: true, upstream: up });
  });

  router.on('GET', '/api/feedback/upstream', (req, res) => {
    const id = who(req, res); if (!id) return;
    sendJson(res, 200, { ok: true, admin: id.kind === 'admin', ...upstream.state({ admin: id.kind === 'admin' }) });
  });

  router.on('POST', '/api/feedback/upstream', async (req, res) => {
    const id = who(req, res); if (!id) return;
    if (id.kind !== 'admin') { sendJson(res, 403, { ok: false, error: '只有管理员能改这里' }); return; }
    let parsed; try { parsed = JSON.parse(await readBody(req, 10_000)); } catch { parsed = {}; }
    if (typeof parsed.enabled !== 'boolean') { sendJson(res, 400, { ok: false, error: 'enabled 必须是 true / false' }); return; }
    try { sendJson(res, 200, { ok: true, admin: true, ...upstream.setPush(parsed.enabled) }); }
    catch (e) { sendJson(res, (e && e.status) || 500, { ok: false, error: String((e && e.message) || e) }); }
  });
}
