// 注册用户的 agy 进程里，每一次工具调用放不放行（钩子脚本 guard-hook.cjs 把调用转来这里判）。
//
// agy 自带的读写文件 / 跑命令工具直接作用在服务器主机上，它自己不设围栏（实测：读工作区之外的文件连问都不问），
// 所以注册用户的会话必须由 bridge 逐次把关。口径与这个人在 Claude 分页的沙箱一致（agents/claude/sandbox.mjs）：
//   · 文件类工具：路径必须落在他自己的文件夹（或这个进程自己的产物目录）里；
//   · 跑命令：只有带命令行权限的档位才有，且过同一套字符串筛查（纵深防御，不是硬边界）；
//   · 不认识的工具一律拒——agy 以后加了新工具，在这里写明之前不会对注册用户生效。
// 返回 null = 不表态（照 agy 平常的流程走，该问用户的照问）；返回 { decision: 'deny', reason } = 拦下。
// 从不返回 allow：那会跳过 agy 自己的审批。

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { withinDir, sandboxViolation } from '@bridge/core/agents/claude/sandbox.mjs';
import { fenceViolation, allowedRoots } from '@bridge/core/runtime/principal.mjs';
import { normalizeAgyPath } from '../paths.mjs';

const deny = (reason) => ({ decision: 'deny', reason });

// 读文件的、写文件的（含各版本 agy 用过的名字）。写类额外不许动 bridge 替他管的系统数据。
const READ_TOOLS = new Set(['read_file', 'view_file', 'view_file_outline', 'list_dir', 'find_by_name', 'grep_search']);
const WRITE_TOOLS = new Set(['write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content']);
const COMMAND_TOOLS = new Set(['run_command', 'send_command_input']);
// 没有固定路径参数的：提问、搜索、子代理（它们各自的工具调用同样过这道钩子）、自带生图。
// 它们的参数里要是带了路径 / 地址（生图的参考图、抓网页的地址），照样过围栏，见 looseArgsViolation。
const PLAIN_TOOLS = new Set([
  'ask_question', 'search_web', 'read_url_content',
  'invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message',
  'generate_image', 'update_focus', 'update_steps', 'task_boundary', 'notify_user', 'finish',
]);
// bridge 自己的工具（服务端按这个人的身份另有把关）。agy 给「同名但配置不同」的服务起的哈希名
//（mcp_bridge_<8 位十六进制>_<工具>）不是 bridge 这一份，不放。
const BRIDGE_TOOL_RE = /^mcp_bridge_(?![0-9a-f]{8}_)[a-z0-9_]+$/;
const PATH_KEYS = /^(?:path|absolutepath|targetfile|file_?path|directory(?:path)?|dir|searchdirectory|searchpath|cwd)$/i;
// 别的工具里名字像路径 / 地址的参数
const LOOSE_PATH_KEY = /path|file|dir|folder/i;
const LOOSE_URL_KEY = /url|uri|link|href/i;
const COMMAND_KEYS = ['CommandLine', 'command', 'Command', 'Input', 'input'];
const OUTSIDE = '该路径在你的私有空间之外，已拒绝——你只能访问自己的文件夹。';

function pathArgs(args) {
  const out = [];
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
    if (typeof v === 'string' && v.trim() && PATH_KEYS.test(k)) out.push(v.trim());
  }
  return out;
}

/**
 * agy 给的路径 → 规整后的绝对路径；不是完整绝对路径返回 ''。
 * agy 混用 C:\x、/C:/x、file:///C:/x 几种写法。Windows 上不带盘符的 \x、/x 是「当前盘的根」，
 * 落到哪个盘取决于 agy 进程的当前目录——说不清就不放。（Claude 沙箱把 /x 当成相对工作区的写法，
 * 那是 Claude CLI 的路径虚拟化，agy 没有这回事，所以这里先自己规整，不把原串直接交给 withinDir。）
 */
export function absoluteAgyPath(raw, platform = process.platform) {
  const s = normalizeAgyPath(String(raw || '').trim(), platform);
  if (!s) return '';
  if (platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s)) return path.win32.normalize(s);
    return '';
  }
  return s.startsWith('/') ? path.posix.normalize(s) : '';
}

/**
 * 一个路径参数可能被解读成的全部绝对路径。normalizeAgyPath 会做百分号解码，而 agy 自己解不解码取决于写法
 * （file:// 的会解，普通路径不一定）——两种读法只要有一种出界就得拦，所以原样的和解码后的都算上。
 * 任何一种读法不是完整绝对路径，返回 null。
 */
export function agyPathReadings(raw, platform = process.platform) {
  const src = String(raw || '').trim();
  const P = platform === 'win32' ? path.win32 : path.posix;
  // 不解码的读法：只去掉 file:// 与盘符前的那个斜杠
  let literal = src.replace(/^file:\/\/\/?/i, '/');
  if (/^\/[a-zA-Z]:([/\\]|$)/.test(literal)) literal = literal.slice(1);
  const isAbs = (s) => (platform === 'win32' ? (/^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s)) : s.startsWith('/'));
  if (!isAbs(literal)) return null;
  const decoded = absoluteAgyPath(src, platform);
  if (!decoded) return null;
  const out = [P.normalize(literal), decoded];
  // 套了两层编码的再解一层
  const twice = absoluteAgyPath(decoded, platform);
  if (!twice) return null;
  out.push(twice);
  return [...new Set(out)];
}

/**
 * Windows 上同一个文件有好几种「看着不一样」的写法：段尾的点和空格会被系统去掉、`名字::$DATA` 是备用数据流、
 * `PROGRA~1` 是 8.3 短名。按字面比路径时它们能绕过「这个目录不许写」的判断，正常路径里又用不到——带这些的一律不放。
 */
export function oddWindowsPath(abs, platform = process.platform) {
  if (platform !== 'win32') return false;
  const segs = String(abs).replace(/^[a-zA-Z]:/, '').replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter(Boolean);
  return segs.some((s) => /[:*?"<>|]/.test(s) || /[. ]$/.test(s) || /~\d/.test(s));
}

const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
// 按字面：abs 是不是 root 本身或它下面的路径（Windows 上不分大小写）
function under(root, abs) {
  const b = fold(path.resolve(root));
  const a = fold(path.resolve(abs));
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
// 只看围栏根以下的那一截写法怪不怪：根本身是部署者定的（装在带 ~1 短名的目录下也得能用）
function oddBelowRoots(roots, abs) {
  const root = roots.find((r) => under(r, abs));
  if (!root) return oddWindowsPath(abs);
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !!rel && oddWindowsPath(rel);
}

// 路径的真实位置：从它往上找到最近一个存在的祖先，取那个祖先的真实路径再把剩下的段接回去
//（目标还不存在时也能看穿中间的目录联接 / 符号链接）
export function realish(abs) {
  let cur = path.resolve(abs);
  const rest = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try { return path.join(realpathSync(cur), ...rest); } catch { return path.resolve(abs); }
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.resolve(abs);
}

const insideAny = (roots, abs) => roots.some((r) => r && withinDir(r, abs));
// 真实位置也得在围栏里：目标还不存在时 withinDir 看不穿中间的目录联接（在自己文件夹里建一个指到外面的联接，再往里写新文件）
const insideReal = (roots, abs) => { const real = realish(abs); return roots.some((r) => r && under(realish(r), real)); };

function relParts(root, abs) {
  if (!root) return null;
  let base = path.resolve(root);
  try { base = realpathSync(base); } catch {}
  for (const b of new Set([base, path.resolve(root)])) {
    const rel = path.relative(b, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).filter(Boolean).map((x) => x.toLowerCase());
  }
  return null;
}

// 回环与内网地址：成员让 agy 去抓的话，等于从服务器这台机器上发请求（bridge 自己、别的本机服务都只认本机直连）
function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.startsWith('::ffff:')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return /^\d+$/.test(h) || /^0x/i.test(h);   // 纯数字 / 十六进制写法的地址也按本机算
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * ctx          这个注册用户的身份上下文（kind 必须是 user）
 * payload      钩子给的原样内容：{ toolCall: { name, args }, cwd, workspacePaths, conversationId, … }
 * artifactDirs 这个人的 agy 进程自己的产物目录（自带生图的成品、草稿），读写放行
 */
export function guardDecision(ctx, payload = {}, { artifactDirs = [] } = {}) {
  if (!ctx || ctx.kind !== 'user' || !ctx.cwd) return deny('这个会话的身份认不出来，已拒绝。');
  const name = String(payload?.toolCall?.name || '').trim().toLowerCase();
  const args = payload?.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  if (!name) return deny('认不出这次调用的是哪个工具，已拒绝。');

  const roots = [...(allowedRoots(ctx) || []), ...artifactDirs].filter(Boolean);
  if (!roots.length) return deny('没有可用的工作目录，已拒绝。');

  // 一个路径：所有读法都得是规范的绝对路径、落在围栏里；返回它的各种读法（含真实位置），出问题返回 { error }
  const fenceOne = (raw) => {
    const readings = agyPathReadings(raw);
    if (!readings) return { error: '请用完整的绝对路径（在你自己的文件夹里）。' };
    const out = [];
    for (const abs of readings) {
      if (oddBelowRoots(roots, abs)) return { error: '这个路径的写法不规范（段尾的点或空格、冒号、~1 这类短名），已拒绝。' };
      if (!insideAny(roots, abs) || !insideReal(roots, abs)) return { error: OUTSIDE };
      out.push(abs, realish(abs));
    }
    return { paths: [...new Set(out)] };
  };
  const fenced = (list) => {
    const out = [];
    for (const raw of list) {
      const f = fenceOne(raw);
      if (f.error) return f;
      out.push(...f.paths);
    }
    return { paths: out };
  };

  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const f = fenced(pathArgs(args));
    if (f.error) return deny(f.error);
    // 文件类工具却没带路径：说不清它要动哪里，不放
    if (!f.paths.length) return deny('这次文件操作没有给出路径，已拒绝。');
    if (WRITE_TOOLS.has(name)) {
      for (const abs of f.paths) {
        // bridge 替他管的系统数据（.bridge 下除了上传与媒体之外的一切：定时任务、偏好、各分页的对话记录与设置）只许 bridge 改
        const sys = relParts(ctx.dataDir, abs);
        if (sys && !(sys[0] === 'uploads' || sys[0] === 'media')) return deny('这是 bridge 替你保管的系统数据，不能直接改。');
        // agy 会执行工作目录里 .agents 下的钩子脚本、git 会执行仓库配置里的命令：没有命令行权限的人不许写这些位置
        if (!ctx.shell && /(?:^|[\\/])(?:\.agents?|_agents?|\.git)(?:[\\/]|$)/i.test(abs)) {
          return deny('这个位置的文件会被当成脚本或仓库配置执行，你的账号没有命令行权限，不能写。');
        }
      }
    }
    return null;
  }

  const screenCommand = (cmd) => fenceViolation(allowedRoots(ctx), (root) => sandboxViolation('PowerShell', { command: cmd }, root));

  if (COMMAND_TOOLS.has(name)) {
    if (!ctx.shell) return deny('你的账号没有命令行权限，不能执行命令。');
    const cmds = COMMAND_KEYS.map((k) => args[k]).filter((v) => typeof v === 'string' && v.trim());
    // 取不到命令原文就没法筛：不放（agy 换了参数名的话，在这里补上之前宁可不能用）
    if (!cmds.length) return deny('认不出这次要执行的命令，已拒绝。');
    for (const cmd of cmds) { const v = screenCommand(cmd); if (v) return deny(v); }
    const f = fenced(pathArgs(args));
    if (f.error) return deny(f.error);
    return null;
  }

  if (name === 'manage_task') {
    // 给后台命令喂输入等于执行命令：没有命令行权限的不给，有的照样过筛
    if (String(args.Action || '') === 'send_input') {
      if (!ctx.shell) return deny('你的账号没有命令行权限。');
      const v = screenCommand(String(args.Input ?? ''));
      if (v) return deny(v);
    }
    return null;
  }

  if (BRIDGE_TOOL_RE.test(name)) return null;
  if (PLAIN_TOOLS.has(name)) {
    const v = looseArgsViolation(args, fenceOne);
    return v ? deny(v) : null;
  }
  return deny(`「${name}」在这个环境里不可用。`);
}

// 没有固定路径参数的工具：参数里名字像路径 / 地址的值（含数组里的）照样过围栏；
// 抓网页的地址不许指向本机文件、回环与内网。说明文字类的参数（Prompt、Message）不看——里面提到路径不等于去读它。
function looseArgsViolation(args, fenceOne) {
  for (const [k, v] of Object.entries(args && typeof args === 'object' ? args : {})) {
    const values = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (!values.length) continue;
    if (LOOSE_URL_KEY.test(k)) {
      for (const raw of values) {
        if (/^file:/i.test(raw)) { const f = fenceOne(raw); if (f.error) return f.error; continue; }
        let u;
        try { u = new URL(raw); } catch { return '这个地址认不出来，已拒绝。'; }
        if (!/^https?:$/.test(u.protocol)) return '只能访问 http / https 的公网地址。';
        if (privateHost(u.hostname)) return '不能访问本机或内网的地址。';
      }
    } else if (LOOSE_PATH_KEY.test(k)) {
      for (const raw of values) { const f = fenceOne(raw); if (f.error) return f.error; }
    }
  }
  return null;
}
