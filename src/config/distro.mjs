// 发行版声明：同一套服务端 + 前端给不同发行版用（bridge 本体、Muse Bridge…），差别只经这里声明，
// 不在代码里散落「是不是 Muse」的判断。config.json 的 distro 对象逐项覆盖；没配 = bridge 本体。
// 叫 distro 不叫 edition：edition 在本体里另有两个意思——老配置的 edition:"host"|"server"（deploy-profile 推「给谁用」的默认值）
// 与构建渠道 BRIDGE_EDITION / bridge-build.json 的 edition（public | private，modules/registry.mjs）。
//   id           发行版标识：'bridge' | 'muse' | 其他小写字母数字（桌面客户端经 /api/app/caps 读，只用来显示品牌）
//   brand        界面里的产品名：前端把文案里的「The Bridge」整体换成它（中英文一起），页面标题、PWA 清单跟着换
//   langDefault  没存过语言偏好时的界面语言：'zh'（本体默认，维护者的 Windows 是英文界面，不能跟系统）| 'browser'（跟浏览器）
//   feedback     用户反馈的去向（知情同意的措辞要说真实去向）：{ to: '中文去向', toEn: 'English destination', public: true }。
//                to 嵌在「发给 {to}」里（≤60 字，不含换行）；toEn 嵌在 "send to {to}" 里（≤80，缺省 = to）；public:true = 去向是公开的
//                （比如中继把反馈发成公开 GitHub Issue），界面与 feedback.* 操作会多一句「会公开发布、别写隐私；图片不公开」的提醒。
//                没声明 = 本体的「bridge 开发者」，所有文案保持原样（此时 resolveDistro 的结果里没有 feedback 这一项）。
//                config 里没声明时，官方安装包的构建期渠道可以带一份（bridge-build.json 的 feedbackDest，打包脚本在写官方中继时
//                一并写入：The Bridge 的公开 GitHub Issue），见下面 channelFeedback。
// 前端经 HTML 壳里注入的 window.__DISTRO__ 读（启动前就要知道：i18n 在任何请求之前定死），见 web/src/lib/distro.js；
// 注入点与 overlay 同一处（runtime/overlay-web.mjs，覆盖 /、/app/*.html、/w/、/c/ 全部 HTML 壳）。
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { config } from './index.mjs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';

const DEFAULTS = Object.freeze({ id: 'bridge', brand: 'The Bridge', langDefault: 'zh' });
// 反馈去向的本体默认值：声明表里没有 feedback 时所有文案用它（= 现状的「bridge 开发者」）
export const FEEDBACK_DEFAULT = Object.freeze({ to: 'bridge 开发者', toEn: 'the Bridge developer', public: false });

const cleanDest = (v, max) => (typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v) && v.trim() && v.trim().length <= max ? v.trim() : '');

// 只接受字符串与布尔；to 不合规回落默认去向，但 public:true 仍然保留（宁可多提醒一句，也不能漏掉「会公开」）
function resolveFeedback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const to = cleanDest(raw.to, 60);
  const isPublic = raw.public === true;
  if (!to && !isPublic) return null;
  const toEn = cleanDest(raw.toEn, 80);
  return Object.freeze({
    to: to || FEEDBACK_DEFAULT.to,
    toEn: toEn || (to ? to : FEEDBACK_DEFAULT.toEn),
    public: isPublic,
  });
}

/** 这份去向是不是发行版声明的（没声明 = 本体默认，文案保持原样） */
export const isFeedbackDeclared = (dest = feedbackDest()) => dest !== FEEDBACK_DEFAULT;

/** 反馈去向，永远给全三项（没声明 = 本体默认） */
export function feedbackDest(ed = DISTRO) {
  return ed && ed.feedback ? ed.feedback : FEEDBACK_DEFAULT;
}

export function resolveDistro(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = typeof e.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(e.id) ? e.id : DEFAULTS.id;
  const brand = typeof e.brand === 'string' && e.brand.trim() && e.brand.length <= 40 ? e.brand.trim() : DEFAULTS.brand;
  const langDefault = e.langDefault === 'browser' ? 'browser' : DEFAULTS.langDefault;
  const feedback = resolveFeedback(e.feedback);
  return Object.freeze({ id, brand, langDefault, ...(feedback ? { feedback } : {}) });
}

/**
 * 构建期渠道声明的反馈去向（程序根 bridge-build.json 的 feedbackDest；只跟构建期的中继地址 feedbackRelay 成对出现）。
 * 中继另配了（环境变量 BRIDGE_FEEDBACK_RELAY 或 config.feedbackRelay，见 runtime/feedback-upstream.mjs）就不是那个去向了，不算数。
 */
export function channelFeedback({ programRoot = PROGRAM_ROOT, cfg = config, env = process.env } = {}) {
  if (String(env.BRIDGE_FEEDBACK_RELAY || '').trim()) return null;
  if (typeof cfg?.feedbackRelay === 'string' && cfg.feedbackRelay.trim()) return null;
  try {
    const j = JSON.parse(readFileSync(path.join(programRoot, 'bridge-build.json'), 'utf8'));
    return j && j.feedbackRelay && j.feedbackDest && typeof j.feedbackDest === 'object' ? j.feedbackDest : null;
  } catch { return null; }
}

/** config.distro 没声明反馈去向时，补上构建期渠道的那份（config 里声明的永远优先） */
export function withChannelFeedback(raw, chan) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return e.feedback || !chan ? e : { ...e, feedback: chan };
}

export const DISTRO = resolveDistro(withChannelFeedback(config.distro, channelFeedback()));

/**
 * 推给中继的 distro：别的发行版带自己的 id（中继按它分流，Muse 的开 Muse 仓库的 Issue）；
 * 本体只有在去向声明为公开时才带 'bridge'（提交人看到过「会公开发布」）——中继据此开 The Bridge 的公开 Issue。
 * 本体没声明公开去向（老版本、自己配中继的部署）不带：中继照旧放进开发者的私有收件箱，不会被公开。
 */
export function relayDistro(ed = DISTRO) {
  if (ed.id !== DEFAULTS.id) return ed.id;
  return ed.feedback && ed.feedback.public === true ? DEFAULTS.id : '';
}

// </head> 前那一行。JSON 里的 < 转义掉，品牌名里写了 </script> 也跳不出标签
export function distroHeadTag(ed = DISTRO) {
  return `<script>window.__DISTRO__=${JSON.stringify(ed).replace(/</g, '\\u003c')};</script>`;
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// HTML 壳里写死的品牌（<title>The Bridge</title>、iOS 主屏名 Bridge）换成发行版的；本体原样返回
export function brandHtml(html, ed = DISTRO) {
  if (ed.brand === DEFAULTS.brand) return html;
  const b = escHtml(ed.brand);
  return html
    .replace(/<title>The Bridge<\/title>/, `<title>${b}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${b}$2`);
}

// PWA 清单（web/public/manifest.webmanifest）的名字跟着发行版走；解析不了原样返回
export function brandManifest(text, ed = DISTRO) {
  if (ed.brand === DEFAULTS.brand) return text;
  try {
    const m = JSON.parse(text);
    m.name = ed.brand;
    m.short_name = ed.brand;
    if (typeof m.description === 'string') m.description = ed.brand;
    return JSON.stringify(m, null, 2);
  } catch { return text; }
}
