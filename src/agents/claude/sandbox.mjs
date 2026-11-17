// 沙箱身份的路径围栏。

import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, NATIVE_ROOT, VAULT } from '../../config/index.mjs';
import { PROGRAM_ROOT } from '../../runtime/paths.mjs';
import { systemWriteViolation, gitInternalsViolation } from '../../runtime/member-boundary.mjs';
import { fenceViolation, allowedRoots } from '../../runtime/principal.mjs';
import { SHARED_ROOT } from '../../extensions.mjs';
import { memberSkillRootIfAny } from '../../member-skills.mjs';
import { NO_SHELL_MSG } from './prompts.mjs';

// Per-user sandbox guard — the SINGLE policy source for the PreToolUse hook (HARD,
// fires on every tool incl. read-only Read/Glob/Grep) AND canUseTool (the ask-path
// backstop). File tools must stay inside the user's folder; Bash is screened for
// paths leaving it. Shell screening is string-based defense-in-depth, NOT a hard
// boundary (a determined shell user can still escape) — which is why 'user' tier
// gets no shell at all.
// 密钥/凭证/配置文件名：命中即拒（子串匹配，robust，不受 SDK 路径虚拟化影响）。这是 withinDir
// 围栏之上的纵深第二层——真实密钥(config.json/凭证/_system)都在 cwd 外、withinDir 已拦，这层兜底。
const SANDBOX_SECRET_RE = /config\.json|credentials?|(^|[\\/])\.env|(^|[\\/])secret|(^|[\\/])token|oauth|passwd|password|apikey|api[_-]?key|id_rsa|id_ecdsa|\.npmrc|\.netrc|(^|[\\/])\.ssh([\\/]|$)|(^|[\\/])\.claude([\\/]|$)|\.(pem|key|keystore|p12|pfx|p8|jks)($|[\\/?'"\s])/i;
// platform 参数只给单测用（在 Windows 上验 Linux 语义），生产一律取 process.platform。
export function withinDir(root, p, platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  try {
    let s = String(p);
    // Windows：SDK 把 cwd 呈现成 POSIX 根 "/"，模型常发 "/foo" 这种「相对 cwd 的绝对写法」，按相对工作区解析
    //（它不是真实 Windows 盘符绝对 C:\ 也不是 UNC \\；否则合法的区内读会被误拒——实测 /mine.txt 会被错拦）。
    // 【只在 Windows 这样做】：Linux/macOS 上 "/data/config.json" 就是真的绝对路径——以前不分平台一律剥掉
    // 开头的斜杠，结果服务端上 Read("/任意文件") 被当成 cwd 里的相对路径放行，沙箱用户能读整机（09-28 修）。
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}/.test(s);
    if (platform === 'win32' && !isWinAbs && /^[\\/]/.test(s)) s = s.replace(/^[\\/]+/, '');
    const base = P.resolve(root);
    const abs = P.resolve(base, s);
    const inside = (t) => t === base || t.startsWith(base.endsWith(P.sep) ? base : base + P.sep);
    if (!inside(abs)) return false;
    // 符号链接/junction 逃逸（pro 用户可 ln -s 出去）：对已存在目标解析真实路径再判一次（不存在则抛错，沿用字符串判定）。
    try { if (!inside(P.resolve(realpathSync(abs)))) return false; } catch {}
    return true;
  } catch { return false; }
}
const PATH_TOOL_KEY = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path' };

// 命令里的 POSIX 绝对路径（三端拆分方案 5.2「收紧」第 2 条）。盘符路径（D:\…）另有更严的规则（cwd 外一律拒）；
// POSIX 路径只做【黑名单】：落在下面这些位置、又不在自己工作目录里的才拒——白名单（cwd 外一律拒）会把
// awk '/^foo/'、sed '/a/,/b/p' 这类正则、/usr/bin/env、/dev/null 大面积误伤。
// Windows 上 Git Bash 的 /c/Users/… 就是盘符路径换了个写法，还原成 C:/Users/… 按盘符规则判。
// 仍是字符串层面的纵深防御，不是硬边界（软隔离，维护者 09-28 知情选择）。
const SENSITIVE_ROOTS = [...new Set([ROOT, PROGRAM_ROOT, NATIVE_ROOT, VAULT, os.homedir(), '/home', '/root', '/proc'].filter(Boolean))];
const POSIX_ABS_RE = /(?:^|[\s'"=:(,])(\/[^\s'"`;|&<>(){},]*)/g;
// 纯函数，platform / roots 可注入（单测在 Windows 上验 Linux 语义）。
export function absPathViolation(cmd, cwd, { platform = process.platform, roots = SENSITIVE_ROOTS } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const inside = (root, p) => { const b = P.resolve(root); const a = P.resolve(p); return a === b || a.startsWith(b.endsWith(P.sep) ? b : b + P.sep); };
  const re = new RegExp(POSIX_ABS_RE.source, 'g');
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const p = m[1];
    if (platform === 'win32') {
      const d = /^\/([a-zA-Z])(\/|$)/.exec(p);
      if (d && !inside(cwd, d[1].toUpperCase() + ':/' + p.slice(3))) return '命令引用了你私有空间之外的路径，已拒绝。';
      continue;   // Windows 上其余 /xxx 多是正则或 URL 路径
    }
    if (p === '/' || inside(cwd, p)) continue;
    if (roots.some((r) => P.isAbsolute(r) && inside(r, p))) return '命令引用了系统或其他用户的目录，已拒绝——你只能访问自己的文件夹。';
  }
  return null;
}
export function sandboxViolation(name, input, cwd, platform = process.platform) {
  const key = PATH_TOOL_KEY[name];
  if (key) {
    const p = input && input[key];
    // 路径围栏即硬边界（含 SDK 虚拟根归一 + 符号链接解析）。不再按文件名拦"密钥"——区内是用户自己的
    // 文件（含他自己的 .env/config.json），区外的真实密钥已被围栏挡住，按名误拦只会妨碍正常开发。
    if (p != null && p !== '' && !withinDir(cwd, p, platform)) return '该路径在你的私有空间之外，已拒绝——你只能访问自己的文件夹。';
    return null;
  }
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String((input && input.command) || '');
    const normCmd = cmd.replace(/\\/g, '/');
    // 越界盘符路径（D:\… 等）。lookbehind 避免 https:// → "s:/" 误报；slash 归一+小写+startsWith 容忍 "bridge-users" 的空格。
    const norm = (s) => s.replace(/\\/g, '/').toLowerCase();
    const cwdN = norm(path.resolve(cwd));
    const re = /(?<![A-Za-z])[A-Za-z]:[\\/]/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      if (!norm(cmd.slice(m.index)).startsWith(cwdN)) return '命令引用了你私有空间之外的路径（如 D:\\…），已拒绝。';
    }
    const absV = absPathViolation(cmd, cwd, { platform });
    if (absV) return absV;
    // 纵深防御（非硬边界）：.. 路径穿越 / 家目录(~ 与 $HOME) / 密钥文件引用。
    if (/\.\.\//.test(normCmd) || /(^|[\s'"():=])\.\.($|[\s'"();])/.test(normCmd)) return '命令包含 .. 路径穿越，已拒绝。';
    if (/(^|[\s'"():=])~[\\/]/.test(cmd) || /\$\{?HOME\b/.test(cmd) || /%USERPROFILE%/i.test(cmd)) return '命令引用了主目录(~)，已拒绝。';
    if (SANDBOX_SECRET_RE.test(normCmd)) return '命令疑似引用密钥/凭证/配置文件，已拒绝。';
    return null;
  }
  return null;
}

// 无 shell 用户：SDK 层直接拿掉这些工具（连尝试都做不到），与 hook 双保险。
export const SHELL_DENY = ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'PowerShell'];

// 管理员「全服统一」加装的扩展（extensions/shared/）对沙箱用户只读开放：技能正文、参考资料要读得到，
// 有命令行的成员要能照 SKILL.md 去那个目录跑脚本。写（Write/Edit）照旧拦；管理员自用的扩展目录不在这棵树里。
// roots 参数只给单测用。
const SHARED_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
export function sharedExtRead(name, input, { root = SHARED_ROOT, platform = process.platform } = {}) {
  if (!SHARED_READ_TOOLS.has(name)) return false;
  const p = input && input[PATH_TOOL_KEY[name]];
  if (typeof p !== 'string' || !p) return false;
  // 只认真实绝对路径：相对路径（含 Windows 上 SDK 虚拟根的 /foo 写法）SDK 按 cwd 解析，与这棵树无关
  const abs = platform === 'win32' ? (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)) : p.startsWith('/');
  return abs && withinDir(root, p, platform);
}
// 命令里出现的全服扩展目录换成占位符再过围栏（盘符 / 正斜杠 / Git Bash 的 /c/… 三种写法）。
// 其余规则（.. 穿越、主目录、密钥名）照常作用在剩下的部分上：shared\skills\x\..\..\config.json 仍被 .. 规则拦下。
export function maskSharedRoot(cmd, { root = SHARED_ROOT, platform = process.platform } = {}) {
  let s = String(cmd || '');
  const fwd = root.replace(/\\/g, '/');
  const forms = new Set([root, fwd]);
  if (platform === 'win32') { const m = /^([a-zA-Z]):\//.exec(fwd); if (m) forms.add('/' + m[1].toLowerCase() + fwd.slice(2)); }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(esc(f), platform === 'win32' ? 'gi' : 'g'), '__bridge_shared_ext__');
  return s;
}
// 沙箱围栏（PreToolUse 主闸、canUseTool 复检、定时任务三处同一口径）：多根围栏 + 全服扩展只读豁免
// + 成员自己添加的技能目录（member-skills.mjs，只有他本人的那一棵）同样只读豁免。
// 身份上挂的只读资料目录（插件沙箱 ctx.sandbox(key, { readDirs }) 给的，ctx.readRoots = [{ root, hide: [相对路径…] }]）：
// Read / Glob / Grep 的绝对路径落在里面就放行（只读，写照拦）；但隐藏的子路径、像密钥的文件名不给读，
// 而且 Glob / Grep 搜的目录里只要含着隐藏项就拒（搜索会读到里面的内容，PreToolUse 过滤不了结果）——让它往具体子目录里搜。
// 返回 null = 不归这条规则管（交给后面的围栏）；'' = 放行；字符串 = 拒绝原因。
export function readRootDecision(ctx, name, input, platform = process.platform) {
  const roots = Array.isArray(ctx?.readRoots) ? ctx.readRoots : [];
  if (!roots.length || !SHARED_READ_TOOLS.has(name)) return null;
  const p = input && input[PATH_TOOL_KEY[name]];
  if (typeof p !== 'string' || !p) return null;
  const abs = platform === 'win32' ? (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)) : p.startsWith('/');
  if (!abs) return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  for (const r of roots) {
    if (!r || !r.root || !withinDir(r.root, p, platform)) continue;
    const rel = P.relative(P.resolve(r.root), P.resolve(p));
    if (rel && SANDBOX_SECRET_RE.test(rel)) return '这个文件不对外开放：' + p;
    const segs = rel ? rel.split(/[\\/]+/) : [];
    for (const h of Array.isArray(r.hide) ? r.hide : []) {
      const hs = String(h).replace(/^[\\/]+|[\\/]+$/g, '').split(/[\\/]+/).filter(Boolean);
      if (!hs.length) continue;
      const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
      const under = segs.length >= hs.length && hs.every((x, i) => same(x, segs[i]));
      if (under) return '这个位置不对外开放：' + p;
      const ancestor = name !== 'Read' && segs.length < hs.length && segs.every((x, i) => same(x, hs[i]));
      if (ancestor) return `这个目录里有不对外开放的部分，不能整个搜：换成具体的子目录再搜（${p}）`;
    }
    return '';
  }
  return null;
}

export function sandboxFence(ctx, name, input) {
  const mine = ctx?.kind === 'user' && !ctx.snap ? memberSkillRootIfAny(ctx.user) : null;
  if (sharedExtRead(name, input) || (mine && sharedExtRead(name, input, { root: mine }))) return null;
  const rr = readRootDecision(ctx, name, input);
  if (rr === '') return null;
  if (rr) return rr;
  let ti = input;
  if ((name === 'Bash' || name === 'PowerShell') && input && typeof input.command === 'string') {
    let command = maskSharedRoot(input.command);
    if (mine) command = maskSharedRoot(command, { root: mine });
    ti = { ...input, command };
  }
  return fenceViolation(allowedRoots(ctx), (root) => sandboxViolation(name, ti, root));
}

// PreToolUse 主闸：SDK 对【每一次】工具调用都先过它——包括只读 Read/Glob/Grep（canUseTool 对只读
// 工具不开火，路径围栏只有落在这里才真生效）。permissionDecision:'deny' 直接拦死且绕过 canUseTool。
// 这是沙箱用户真正的硬边界（canUseTool 仅作"会弹确认工具"的兜底）。
export function makeSandboxPreToolUse(ctx) {
  return async (input) => {
    const name = input.tool_name, ti = input.tool_input || {};
    if (!ctx.shell && SHELL_DENY.includes(name)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_SHELL_MSG } };
    }
    // 多根围栏（开源路线 C5）：落在 allowedRoots(ctx) 任意一个根内即放行；今天沙箱身份只有 [ctx.cwd]。另放行全服扩展目录的只读。
    const v = sandboxFence(ctx, name, ti)
      // 自己的系统数据（.bridge 顶层的 routines.json、偏好、CLI 配置、对话记录）只许 bridge 改（开源路线 S2-5，runtime/member-boundary.mjs）
      || systemWriteViolation(name, ti, ctx.dataDir, ctx.cwd)
      // 没有命令行的：不许改 .git 内部（仓库配置能让服务端替他跑的 git 执行任意命令）
      || (!ctx.shell ? gitInternalsViolation(name, ti, ctx.cwd) : null);
    if (v) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v } };
    return { continue: true };
  };
}
