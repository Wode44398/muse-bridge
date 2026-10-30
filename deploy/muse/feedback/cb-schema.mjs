// claude-bridge（The Bridge）服务器转来的用户反馈：跟 Muse 的问题报告是两回事——不进 GitHub，
// 只进 Worker 的私有收件箱（KV，带过期），由开发者那台 bridge 定时来取（feedback-worker/src/cb.mjs）。
//
// 同样走白名单：这里没列的字段，不管对方服务器塞了什么，一律存不进来。
//   文字（用户自己写的，按 Muse 那套规则脱敏）、界面位置、bridge 版本、平台（系统 / 架构 / Node）、
//   提交人在那台服务器上的角色（admin / user，不带用户名）、没随报告发来的附件个数、
//   发行版 id（distro：bridge 本体不带；别的发行版带自己的 id，Worker 据此分流，见 feedback-worker/src/cb-muse.mjs）、
//   最多 3 张图片（每张 ≤ 2MB；只认 png / jpeg / gif / webp，且按文件头认，声明的类型不算数；文件名一律重起）。
// 图片没法脱敏：前端提交界面写明了「图片会一起发给开发者」，由用户自己决定放不放。
// distro = 'muse' / 'bridge' 的那份不进收件箱、转成 Muse Bridge / The Bridge 仓库的公开 Issue——图片不随 Issue 公开，只记个数。
import { scrub, clip } from './scrub.mjs';

export const CB_MAX_IMAGES = 3;
export const CB_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// 一份报告的请求体上限：3 张 2MB 图片的 base64（约 8MB）加文字，留点余量
export const CB_MAX_BODY = 9 * 1024 * 1024;
const PLATFORMS = ['win32', 'linux', 'darwin', 'freebsd', 'android', 'other'];

const tok = (v, re, max = 40) => { const s = String(v ?? '').trim(); return s.length <= max && re.test(s) ? s : ''; };
const oneOf = (v, list, dflt = '') => (list.includes(v) ? v : dflt);
const int = (v, max = 1e9) => (Number.isFinite(+v) && +v >= 0 ? Math.min(Math.floor(+v), max) : 0);

/**
 * base64 解码后的字节数；不是规整的 base64 回 -1。
 * 用「找非法字符」的写法：Worker 免费档每次请求只有 10ms CPU，锚定的 ^[…]+$ 扫一张 2MB 图就要近 10ms，这种写法约 1ms。
 * 校验过的串只含 base64 字符，存进 KV 的 JSON 里不需要转义，收件接口直接拼接也安全。
 */
function b64Bytes(s) {
  if (!s || s.length % 4 || /[^A-Za-z0-9+/=]/.test(s)) return -1;
  const eq = s.indexOf('=');
  if (eq !== -1 && eq < s.length - 2) return -1;
  return (s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
}

/** 按文件头认图片类型（只看前 12 字节）；认不出回 '' */
export function sniffImage(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(0);
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return '';
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function headOf(b64) {
  try { return Uint8Array.from(atob(b64.slice(0, 16)), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(0); }
}

/**
 * 把任意输入整理成一份干净的 claude-bridge 反馈；缺装机编号、或者既没文字也没图片就抛错（Worker 回 400）。
 * 不合格的图片（类型不对、超 2MB、第 4 张起）直接丢，计进 omitted。
 */
export function cleanCbReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const install = tok(i.install, /^[A-Za-z0-9-]{8,64}$/, 64);
  if (!install) throw new Error('bad install id');
  const out = {
    v: 1,
    install,
    text: clip(scrub(typeof i.text === 'string' ? i.text : ''), 8000).trim(),
    screen: clip(scrub(typeof i.screen === 'string' ? i.screen : ''), 80).trim(),
    version: tok(i.version, /^[0-9A-Za-z][0-9A-Za-z .()_+-]*$/, 40),
    platform: oneOf(i.platform, PLATFORMS, 'other'),
    arch: tok(i.arch, /^[a-z0-9_]+$/, 12),
    node: tok(i.node, /^v?[0-9.]+$/, 20),
    os: tok(i.os, /^[A-Za-z_]+(?: [0-9.]+)?$/, 40),
    role: oneOf(i.role, ['admin', 'user']),
    lang: oneOf(i.lang, ['zh', 'en']),
    distro: tok(i.distro, /^[a-z][a-z0-9-]{0,31}$/, 32),
    omitted: int(i.omitted, 50),
    attachments: [],
  };
  for (const a of Array.isArray(i.attachments) ? i.attachments.slice(0, 12) : []) {
    const data = a && typeof a.data === 'string' ? a.data : '';
    const n = b64Bytes(data);
    const type = n > 0 && n <= CB_MAX_IMAGE_BYTES ? sniffImage(headOf(data)) : '';
    if (!type || out.attachments.length >= CB_MAX_IMAGES) { out.omitted++; continue; }
    out.attachments.push({ name: `image-${out.attachments.length + 1}.${EXT[type]}`, type, size: n, data });
  }
  for (const k of ['screen', 'version', 'arch', 'node', 'os', 'role', 'lang', 'distro']) if (!out[k]) delete out[k];
  if (!out.omitted) delete out.omitted;
  if (!out.text && !out.attachments.length) throw new Error('empty report');
  return out;
}
