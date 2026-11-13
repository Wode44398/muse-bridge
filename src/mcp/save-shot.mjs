// 浏览器截图落盘（save_to）：Claude 的内置浏览器（browser-tools.mjs）与设备浏览器（device-tools.mjs）共用。
// 以前截图只随结果回一张图，agent 要存成文件（写进报告、前后对比、发给用户）只能去 tool-results 里翻
// mcp-browser-blob-*.png 再拷（11-07 四个会话都这么绕，调试反馈 B4）。动作层不碰磁盘——设备浏览器的图是
// 在客户端那头截的——落盘统一放在 MCP 层：结果里有几张 PNG 就写几张，回执补一句存到了哪、多大。

import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { pngSize } from '../runtime/cdp.mjs';

export const SAVE_TO_DESC = '把这次结果里的截图另存成 PNG 文件（screenshot / screenshot_after / batch 里的都算）：相对路径按工作空间算；以 / 结尾或是已有目录 = 存进去、自动起名；一次多张时依次加 -1、-2…。图照样随结果返回，回执写明存到哪、多大';

const NOT_PNG = /^\.(jpe?g|webp|gif|bmp|avif|tiff?)$/i;

// 路径还不存在也要按真实路径判（软链 / 联接点能把「工作空间里的路径」指到外面）：取最近一级存在的祖先求真实路径，再接上剩下的。
function realOf(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(realpathSync.native ? realpathSync.native(head) : realpathSync(head), ...rest); } catch {}
    const up = path.dirname(head);
    if (up === head) return path.join(head, ...rest);
    rest.unshift(path.basename(head));
    head = up;
  }
}

/**
 * save_to 相对 base（工作空间）解析成绝对路径。roots 非空 = 沙箱身份，只准落在这些目录里（按真实路径判）。
 * 返回 { path } 或 { error }。
 */
export function resolveSaveTo(raw, base, roots = null) {
  const abs = path.resolve(base || process.cwd(), String(raw));
  if (roots) {
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const inside = (t, root) => t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    const list = roots.filter(Boolean);
    // 先按字面判、不碰磁盘（同 withinDir）：字面上就在外面的不去求真实路径——\\host\share 这种 UNC 一求就是
    // 服务器带着本机凭据去连别人的共享。字面在里面的再按真实路径复核（软链 / 联接点）。
    const ok = list.some((r) => inside(fold(abs), fold(path.resolve(r))))
      && list.some((r) => inside(fold(realOf(abs)), fold(realOf(r))));
    if (!ok) return { error: `save_to 只能存进你的工作空间或媒体目录，「${raw}」解析到了外面（${abs}）` };
  }
  return { path: abs };
}

/**
 * 动作之前先把 save_to 定下来（路径不合法就别白做一遍动作）。resolve(raw) → { path } | { error }。
 * 返回 { dir } / { file } / { error }：目录模式自动起名 shot-YYYYMMDD-HHMMSS.png；文件模式没写扩展名就补 .png。
 */
export function saveTarget(raw, resolve) {
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'save_to 是空的：给一个 .png 文件名或目录' };
  const r = resolve(s);
  if (r.error) return { error: r.error };
  const abs = r.path;
  let isDir = /[\\/]$/.test(s);
  if (!isDir) { try { isDir = statSync(abs).isDirectory(); } catch {} }
  if (isDir) return { dir: abs };
  const ext = path.extname(abs);
  if (NOT_PNG.test(ext)) return { error: `save_to 只存 PNG（截图本来就是 PNG）：把「${s}」换成 .png 结尾，或给一个目录` };
  return { file: ext.toLowerCase() === '.png' ? abs : `${abs}.png` };
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const exists = (p) => stat(p).then(() => true, () => false);

// n 张图各落到哪：文件模式 a.png → a.png（一张）/ a-1.png、a-2.png…（多张），同名就覆盖；
// 目录模式自动起名，撞名往后加序号，不覆盖。
async function filesFor(target, n) {
  if (target.file) {
    if (n === 1) return [target.file];
    const ext = path.extname(target.file);
    const stem = target.file.slice(0, -ext.length);
    return Array.from({ length: n }, (_, i) => `${stem}-${i + 1}${ext}`);
  }
  const base = path.join(target.dir, `shot-${stamp()}`);
  if (n === 1 && !(await exists(`${base}.png`))) return [`${base}.png`];
  const out = [];
  for (let i = 1; out.length < n; i++) if (!(await exists(`${base}-${i}.png`))) out.push(`${base}-${i}.png`);
  return out;
}

/**
 * 把 result（MCP 结果）里的 PNG 截图写到 target（saveTarget 的返回），回执补在最后一个文字块上。不抛错。
 * recheck(absPath) → { error? }：落盘前再验一次（同 saveTarget 的 resolve）——动作要跑好几秒，这期间
 * 沙箱用户能把还不存在的目录换成指向外面的联接点，只在动作前验一次挡不住。
 */
export async function saveShots(result, target, recheck = null) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const shots = [];
  content.forEach((c, i) => {
    if (c?.type !== 'image' || c.mimeType !== 'image/png' || !c.data) return;
    const prev = content[i - 1];
    shots.push({ data: c.data, step: prev?.type === 'text' ? /^第 \d+ 步/.exec(String(prev.text))?.[0] || '' : '' });
  });
  let lines;
  if (!shots.length) {
    lines = [`save_to：这次结果里没有截图，什么也没存（${result?.isError ? '动作没成功' : '只有 screenshot / screenshot_after 会出图'}）。`];
  } else {
    lines = [];
    try {
      const files = await filesFor(target, shots.length);
      const guard = (p) => { const c = recheck?.(p); if (c?.error) throw new Error(c.error); };
      guard(files[0]);
      await mkdir(path.dirname(files[0]), { recursive: true });
      for (let k = 0; k < shots.length; k++) {
        const what = shots[k].step ? `${shots[k].step}的截图` : shots.length > 1 ? `第 ${k + 1} 张截图` : '截图';
        try {
          const buf = Buffer.from(shots[k].data, 'base64');
          const had = target.file ? await exists(files[k]) : false;
          guard(files[k]);
          await writeFile(files[k], buf);
          const { width, height } = pngSize(buf);
          lines.push(`${what}已存到 ${files[k]}（${width}×${height}${had ? '，覆盖了原文件' : ''}）`);
        } catch (e) {
          lines.push(`⚠ ${what}没存成（${files[k]}）：${e?.message || e}`);
        }
      }
    } catch (e) {
      lines.push(`⚠ save_to 没存成：${e?.message || e}（图照样附在结果里）`);
    }
  }
  const out = result && Array.isArray(result.content) ? result : { content: [] };
  const last = [...out.content].reverse().find((c) => c.type === 'text');
  if (last) last.text += `\n${lines.join('\n')}`;
  else out.content.push({ type: 'text', text: lines.join('\n') });
  return out;
}
