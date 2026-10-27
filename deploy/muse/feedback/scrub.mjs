// 反馈报告的脱敏与归一（服务端出草稿时用一遍，Worker 收到后再用一遍——两边是同一份代码）。
//
// 报告本身走白名单：只收集事先列好的字段（版本、agent、服务状态、我们自己代码里的报错……），对话内容、
// 文件、key、地址从源头就不收。这里管的是剩下那几处自由文本——用户自己写的描述、报错消息、更新失败的日志行——
// 把里面可能夹带的令牌、邮箱、网址、路径、IP 换成占位符。规则宁可多打码：报告是公开的 GitHub Issue。

// 各家令牌 / key 的已知格式
const SECRET_RES = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,                  // Anthropic（含 Claude 订阅的 sk-ant-oat）
  /\bsk-(?:proj-|kimi-)?[A-Za-z0-9_-]{16,}/g,     // OpenAI / DeepSeek / Kimi 订阅 …
  /\btp-[A-Za-z0-9_-]{16,}/g,                     // 小米 Token Plan
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                // GitHub 令牌
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,                    // Google
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,              // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,   // JWT（Cloudflare 隧道令牌也是 base64 的 JSON）
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{6,}/gi,
];
// 没有已知前缀、但长得像密钥的串：≥ 24 位、字母和数字混着出现
// （不含 /：仓库里的相对路径要原样留着；base64 里的 / 把串切开后，长段照样会被逮到）
const OPAQUE_RE = /[A-Za-z0-9_+-]{24,}/g;
const looksOpaque = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s) && !/^[a-z]+(?:[-_][a-z]+)+$/i.test(s);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 网址只吃 ASCII：后面紧跟的中文（「…打不开，联系我」）不能被当成网址的一部分吞掉
const URL_RE = /\b(?:https?|wss?):\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 我们自己程序目录里的路径：只留仓库内相对路径（src/routes/x.mjs），这是排查要用的
const OWN_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s"'()<>]*?[\\/]bridge[\\/]((?:src|harness|web|deploy|scripts|public)[\\/][^\s"'()<>:]*)/g;
// 其余绝对路径（用户目录、数据目录、临时目录……）一律打码
// 路径里可以有中文文件名（照样打码），但遇到中文全角标点（，。、）」）就算结束
const ABS_PATH_RE = /(?:\b[A-Za-z]:\\[^\s"'<>|　-〿＀-￯]+|(?<![\w.:/-])\/(?:home|root|tmp|var|srv|mnt|data|Users|opt|run|etc|usr)\/[^\s"'<>()　-〿＀-￯]*)/g;

// 出现在 URL 里也照样保留主机名的公共站点（报「连不上 api.anthropic.com」这种信息有用，也不涉及隐私）
const PUBLIC_HOSTS = new Set([
  'api.anthropic.com', 'api.deepseek.com', 'api.openai.com', 'dashscope.aliyuncs.com', 'open.bigmodel.cn',
  'api.kimi.com', 'api.moonshot.cn', 'generativelanguage.googleapis.com', 'api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com',
  'html.duckduckgo.com', 'github.com', 'api.github.com', 'objects.githubusercontent.com', 'registry.npmjs.org',
  'api.trycloudflare.com', 'region1.v2.argotunnel.com', 'region2.v2.argotunnel.com', 'platform.claude.com', 'claude.ai',
]);
export const isPublicHost = (h) => PUBLIC_HOSTS.has(String(h || '').toLowerCase());

function urlRepl(u) {
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch {}
  if (/\.trycloudflare\.com$/.test(host) && host !== 'api.trycloudflare.com') return '<tunnel-url>';
  if (host === '127.0.0.1' || host === 'localhost') {
    try { const p = new URL(u); return `http://127.0.0.1:${p.port || 80}${p.pathname.replace(/[^/]{24,}/g, '<id>')}`; } catch { return '<local-url>'; }
  }
  return isPublicHost(host) ? `https://${host}/…` : '<url>';
}

/**
 * 把一段自由文本脱敏。opts.literals：额外要抹掉的字面值（公网主机名、用户名……），先于规则替换。
 */
export function scrub(text, opts = {}) {
  let s = String(text ?? '');
  if (!s) return '';
  for (const lit of opts.literals || []) {
    const v = String(lit || '').trim();
    if (v.length >= 3) s = s.split(v).join('<redacted>');
  }
  for (const re of SECRET_RES) s = s.replace(re, '<secret>');
  s = s.replace(URL_RE, urlRepl);
  s = s.replace(EMAIL_RE, '<email>');
  s = s.replace(OWN_PATH_RE, (_, rel) => rel.replace(/\\/g, '/'));
  s = s.replace(ABS_PATH_RE, '<path>');
  s = s.replace(IPV4_RE, (ip) => (ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : '<ip>'));
  s = s.replace(UUID_RE, '<id>');
  s = s.replace(OPAQUE_RE, (m) => (looksOpaque(m) ? '<secret>' : m));
  return s;
}

/** 截到 max 个字符（按码点，不劈开中文 / emoji） */
export function clip(s, max) {
  const a = Array.from(String(s ?? ''));
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join('');
}

// —— 报错归一：同一个 bug 在不同机器上算出同一个指纹 ——

/** 报错消息里去掉每次都不同的部分（数字、引号里的值、地址……），留下「是哪种错」 */
export function normalizeMessage(msg) {
  return scrub(msg)
    .replace(/'[^']{0,200}'|"[^"]{0,200}"|`[^`]{0,200}`/g, '…')
    .replace(/\b0x[0-9a-f]+\b/gi, 'N')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * 从堆栈里只挑我们自己代码的帧：「函数名 (src/routes/x.mjs)」，不带行号（行号随版本漂，指纹要跨版本稳定）。
 * 浏览器里的帧是打包后的 /app/assets/index-<hash>.js，文件名去掉 hash，函数名多半是压缩过的，照样只当参考。
 */
export function ownFrames(stack, max = 6) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.*?)(?::\d+)?(?::\d+)?\)?\s*$/);
    if (!m) continue;
    const fn = (m[1] || '<anonymous>').replace(/^async\s+/, '').slice(0, 80);
    const file = m[2] || '';
    let rel = '';
    const own = file.match(/[\\/]bridge[\\/]((?:src|harness)[\\/][^\s:]+)/) || file.match(/^(?:file:\/\/)?.*?[\\/]((?:src|harness)[\\/](?!.*node_modules)[^\s:]+)/);
    if (own && !/node_modules/.test(file)) rel = own[1].replace(/\\/g, '/');
    else if (/\/app\/assets\//.test(file)) rel = 'web/' + file.replace(/^.*\/app\/assets\//, '').replace(/-[A-Za-z0-9_]{6,}(?=\.js)/, '');
    if (!rel) continue;
    out.push(`${fn} (${rel})`);
    if (out.length >= max) break;
  }
  return out;
}

/** 指纹：错误类型 + 归一后的消息 + 前三帧。12 位十六进制，够区分、又短到能放进标题 */
export async function fingerprint(parts) {
  const data = new TextEncoder().encode(parts.filter(Boolean).join('|'));
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function errorFingerprint({ where = 'server', type = 'Error', message = '', frames = [] }) {
  return fingerprint([where, type, normalizeMessage(message), ...frames.slice(0, 3)]);
}
