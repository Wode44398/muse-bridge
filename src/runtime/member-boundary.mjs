// 成员边界（开源路线 S2-5）：给成员身份起的子进程用什么环境变量，成员的 agent 不许改哪些系统文件。
//
// 一、环境变量。服务进程的环境里可能有部署者自己的各种凭据（各家 API key、令牌、云厂商凭据、bridge 的访问令牌……），
//    以前成员的 Claude CLI 与终端一律 {...process.env} 原样继承。现在分两种：
//    · 白名单（memberProcessEnv shell:false）：没有命令行的身份——普通档成员、聊天快照访客。只留系统必需项
//      （PATH、SystemRoot、语言、代理、证书……）与 Claude Code 自己的开关；HOME / USERPROFILE / APPDATA / TEMP
//      指到他自己的目录（<dataDir>/home、<dataDir>/tmp）。他碰不到命令行，这层是纵深防御。
//    · 剔除（shell:true）：有命令行的成员（Pro / 完全信任档）与成员工作区里开的终端。照常继承（他们的 git、npm、
//      Python 不受影响），但按名字剔掉一切像凭据的变量和 bridge 自己的内部变量。命令行本身不是硬边界——Pro 跑 env
//      仍能看到 CLI 认证用的那一个令牌，这是「完全信任」的定义，见开源路线 S2-2。
//    CLI 认证要用的那一份（claudeAuthCarry）由 claudeEngineEnv 单独补回去，别的一概不带。
//    没有命令行的 Claude CLI 还关掉开会话时取 git 状态（CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS），并带一组 git 配置覆盖
//    （memberGitConfigEnv）：CLI 会在他目录里跑 git，仓库配置是他能写的。理由见 memberEngineBase。
//    两种模式都带 git 的天花板（GIT_CEILING_DIRECTORIES = 用户根、快照桶总目录）：终端、服务端替成员跑的 git 不会往上
//    找到 bridge 自己的仓库（CLI 自己取 git 状态时不认它，所以上一条另外关掉）。
//    dimensio 的租户进程有自己的一套（modules/dimensio TENANT_ENV_DROP + harness 子进程白名单），不走这里。
//
// 二、系统文件写保护（systemWriteViolation）：成员的系统数据目录 .bridge 在他自己的工作目录里，路径围栏挡不住。
//    agent 的写类工具不许写 .bridge 顶层的文件（routines.json、权限模式、会话偏好、项目表……）与 .bridge/claude
//    顶层的文件（CLI 的 .claude.json、settings.json、凭据）——改了 routines.json 就能写一条 Ultracode 定时任务、
//    绕过档位与额度。子目录照常可写：临时对话桶 quickchat/、工作区 workspaces/、自动记忆 claude/projects/*/memory/。

import path from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { NATIVE_ROOT, ROOT } from '../config/index.mjs';

const up = (k) => String(k).toUpperCase();

// 系统必需项（Windows 上环境变量名不分大小写，一律按大写比）。
const SYSTEM_KEEP = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'PSMODULEPATH', 'DRIVERDATA',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'SHELL',
  // 出站代理与自定义证书：国内服务器连 Anthropic 要靠它们（net-proxy.mjs 运行时也会写 HTTP(S)_PROXY / NO_PROXY）
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
// Claude Code 自己的开关（模型、超时、遥测开关……）与语言区域。凭据样的名字仍会被下面的 SECRET_NAME_RE 剔掉。
const KEEP_PATTERNS = [/^LC_/i, /^CLAUDE_/i, /^ANTHROPIC_/i, /^DISABLE_/i, /^MCP_/i, /^MAX_THINKING_TOKENS$/i, /^API_TIMEOUT_MS$/i, /^BASH_(DEFAULT|MAX)_/i];

// 像凭据的变量名：照 Claude Code 自己清洗子进程环境用的那条规则（CLAUDE_CODE_SUBPROCESS_ENV_SCRUB）。
// TOKEN / SECRET / PASSWORD 出现在名字任意一段末尾就算；KEY / AUTH / PAT 之类要成段（GITHUB_PAT、ANTHROPIC_API_KEY）。
// MAX_OUTPUT_TOKENS 这种复数不算（TOKEN 后面跟着 S）。
const SECRET_NAME_RE = new RegExp(
  '((^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|KEY|AUTH|COOKIE|PAT|DSN|WEBHOOK|CREDENTIAL|CREDENTIALS|CREDS|APIKEY|ACCESSKEY|SECRETKEY|ACCOUNTKEY|PRIVATEKEY|AUTHKEY|SSHKEY|SIGNINGKEY|MASTERKEY|DEPLOYKEY|ENCRYPTIONKEY|PGPASSWORD|SSHPASS|(KEY|SECRET|PASSWORD|CREDENTIAL)S)'
  + '|_(PWD|PASS|JWT)|(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE))(?=$|[_0-9])', 'i');
// 连接串（DATABASE_URL 这类带口令的）与 bridge / dimensio 自己的内部变量，有命令行的身份也不给。
// 还有服务进程自己若是从某个 Claude Code 会话里起的（维护者在会话里重启服务）会继承的那个会话的身份与通道：
// 跨会话消息的套接字、宿主会话 id、登录邮箱 / 组织 / 账号 uuid、SDK 宿主标记——成员的 CLI 不该连到主机那个会话上。
const ALWAYS_DROP = [
  /CONN(ECT(ION)?)?_?STR(ING)?S?($|[_0-9])/i, /^DATABASE_URL$/i, /^REDIS_URL$/i, /^BRIDGE_/i, /^DIMENSIO_/i, /^HARNESS_/i, /^OTEL_/i,
  /^CLAUDE_CODE_(MESSAGING_|HOST_|SESSION_|CHILD_SESSION|USER_|ACCOUNT_|ORGANIZATION_|ENTRYPOINT|EXECPATH|SDK_|DESKTOP_|REMOTE_|OAUTH_SCOPES)/i,
  /^CLAUDE_AGENT_SDK_/i, /^CLAUDE_PID$/i,
];

export const looksSecret = (name) => SECRET_NAME_RE.test(String(name)) || ALWAYS_DROP.some((re) => re.test(String(name)));

// 云厂商形态的 Claude（Bedrock / Vertex / Foundry）：凭据在环境变量或家目录里（ADC、~/.aws），
// 这种部署不重定向家目录，并把对应的凭据带给 CLI——否则成员的 Claude 根本认证不了。
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
export function cloudClaude(src = process.env) {
  return truthy(src.CLAUDE_CODE_USE_BEDROCK) || truthy(src.CLAUDE_CODE_USE_VERTEX) || truthy(src.CLAUDE_CODE_USE_FOUNDRY);
}

// git 往上找仓库的天花板：用户根与快照桶的总目录。数据根就是程序目录的部署（源码直跑；开源版默认用户根是
// <仓库>/users），成员目录与快照桶都在 bridge 自己的 git 工作树里——不设的话，成员目录里没有仓库时 git 会一路找到
// bridge 的仓库，CLI 开会话时把它的分支、改动文件名、最近的提交写进系统上下文，快照访客问一句就拿到了。
// 天花板只挡「往上找进这两个目录本身或更上面」，成员自己目录里的仓库照常。
export function memberGitCeilings() {
  return [NATIVE_ROOT, path.join(ROOT, 'chat-snapshots')].map((p) => path.resolve(p));
}
function withCeilings(out, src, ceilings) {
  if (!ceilings || !ceilings.length) return out;
  // Windows 上名字不分大小写：并进已有的那一项（部署者自己设过的照留），不另起一个大小写不同的键
  const key = Object.keys(out).find((k) => up(k) === 'GIT_CEILING_DIRECTORIES') || 'GIT_CEILING_DIRECTORIES';
  const srcKey = Object.keys(src || {}).find((k) => up(k) === 'GIT_CEILING_DIRECTORIES');
  const have = String((srcKey && src[srcKey]) || '').split(path.delimiter).filter(Boolean);
  out[key] = [...new Set([...have, ...ceilings])].join(path.delimiter);
  return out;
}

/**
 * 成员身份子进程的基础环境（不含 Claude 的认证，见 claudeAuthCarry）。
 * @param {object} src 来源环境（默认 process.env）
 * @param {{ shell?: boolean, home?: string, ceilings?: string[] }} opts shell=true 走剔除模式；home 非空（且不是云厂商形态）时
 *   把家目录与临时目录指过去；ceilings = git 往上找仓库的天花板（默认 memberGitCeilings()，两种模式都加）
 */
export function memberProcessEnv(src = process.env, { shell = false, home = '', ceilings = memberGitCeilings() } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (v == null) continue;
    if (looksSecret(k)) continue;
    if (shell) { out[k] = v; continue; }
    if (SYSTEM_KEEP.has(up(k)) || KEEP_PATTERNS.some((re) => re.test(k))) out[k] = v;
  }
  withCeilings(out, src, ceilings);
  if (!shell && home && !cloudClaude(src)) {
    const h = path.resolve(home);
    const tmp = path.join(path.dirname(h), 'tmp');
    const dirs = { HOME: h, USERPROFILE: h, APPDATA: path.join(h, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(h, 'AppData', 'Local'), TEMP: tmp, TMP: tmp, TMPDIR: tmp };
    // Windows 上同名不同大小写的旧键先去掉，免得 spawn 时两个 Path 打架
    for (const k of Object.keys(out)) if (up(k) in dirs) delete out[k];
    for (const [k, d] of Object.entries(dirs)) {
      if (process.platform !== 'win32' && (k === 'APPDATA' || k === 'LOCALAPPDATA' || k === 'USERPROFILE')) continue;
      try { mkdirSync(d, { recursive: true }); } catch {}
      out[k] = d;
    }
  }
  return out;
}

// CLI 认证要用的变量：从来源环境原样带上（部署者给的 API Key / 网关地址与令牌 / 云厂商凭据）。
// 号池的订阅令牌由 claudeEngineEnv 另行注入，覆盖这里的同名项。
const AUTH_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const CLOUD_KEYS = [/^AWS_/i, /^GOOGLE_APPLICATION_CREDENTIALS$/i, /^GOOGLE_CLOUD_PROJECT$/i, /^CLOUD_ML_REGION$/i, /^ANTHROPIC_VERTEX_/i, /^ANTHROPIC_BEDROCK_/i, /^ANTHROPIC_FOUNDRY_/i, /^AZURE_/i, /^VERTEX_REGION_/i];
export function claudeAuthCarry(src = process.env) {
  const out = {};
  for (const k of AUTH_KEYS) if (src[k]) out[k] = src[k];
  if (cloudClaude(src)) for (const [k, v] of Object.entries(src)) if (v != null && CLOUD_KEYS.some((re) => re.test(k))) out[k] = v;
  return out;
}

/**
 * 成员身份的 Claude CLI 基础环境（claudeEngineEnv 在它上面再加 CLAUDE_CONFIG_DIR、号池令牌、上游代理）。
 * 没有命令行的（普通档成员、快照访客）再加两样：
 *   · CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1：CLI 开会话时不再取 git 状态写进系统上下文（git status、git log -n 5、
 *     分支）。这是真正起作用的那道闸——CLI（2.1.299 实测源码）找仓库是自己往上逐级找 .git，不认 GIT_CEILING_DIRECTORIES；
 *     跑这几条 git 时还会把环境里的 GIT_CEILING_DIRECTORIES、GIT_CONFIG_COUNT / KEY / VALUE 一并剥掉、换成它自己的。
 *     不关的话：成员目录、快照桶在 bridge 自己的仓库里时（源码直跑），访客一问就拿到 bridge 仓库的分支、改动文件名、
 *     最近的提交；仓库配置里埋了 log.showSignature + gpg.program 时，那条 git log 还会以服务器账户执行它。
 *     他们没有命令行，git 的提交 / PR 说明本来也用不上。
 *   · memberGitConfigEnv：CLI 不经那套剥环境变量的路子直接跑的 git 照样吃这组覆盖（纵深防御）。
 * 有命令行的本来就能跑任何东西，不加。
 */
export function memberEngineBase(ctx, src = process.env) {
  const shell = !!(ctx && ctx.shell);
  const home = !shell && ctx && ctx.dataDir ? path.join(ctx.dataDir, 'home') : '';
  const noShell = shell ? {} : { ...memberGitConfigEnv(), CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' };
  return { ...memberProcessEnv(src, { shell, home }), ...claudeAuthCarry(src), ...noShell };
}

// 终端（claude-term.mjs）：按工作区判断是不是成员的——在用户根或快照桶下面的，走剔除模式。
const fold = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
const under = (root, p) => { const b = fold(root); const a = fold(p); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
export function isMemberPath(ws) {
  if (!ws) return false;
  return under(NATIVE_ROOT, ws) || under(path.join(ROOT, 'chat-snapshots'), ws);
}
// owner = 池键里的属主（principal.poolRef）：不是主机身份的一律按成员处理；只给路径的老调用方按路径判。
export function terminalEnv(ws, src = process.env, { owner = '' } = {}) {
  const member = (owner && owner !== 'admin') || isMemberPath(ws);
  return member ? memberProcessEnv(src, { shell: true }) : src;
}

// ---- 系统文件写保护 ----
const WRITE_KEY = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const SYSTEM_WRITE_MSG = '这是 bridge 的系统数据（定时任务、偏好、会话索引、CLI 配置、对话记录），只能由 bridge 自己改，已拒绝。';
const GIT_WRITE_MSG = '不能直接改 git 仓库的内部文件（.git 目录）。改代码照常写工作区里的文件就行。';

// 写类工具要写的目标：{ P, abs, real }（real = 父目录按真实路径解析后的目标，父目录不存在为 null）；不是写类工具 → null
function writeTarget(name, input, cwd, platform) {
  const key = WRITE_KEY[name];
  if (!key) return null;
  const raw = input && input[key];
  if (raw == null || raw === '') return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  let s = String(raw);
  // 同 claude.mjs withinDir：Windows 上 SDK 把 cwd 呈现成 "/"，"/foo" 是相对工作区的写法
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}/.test(s);
  if (platform === 'win32' && !isWinAbs && /^[\\/]/.test(s)) s = s.replace(/^[\\/]+/, '');
  const abs = P.resolve(P.resolve(cwd || '.'), s);
  // 经符号链接 / junction 指进来的：按父目录的真实路径再判一次（父目录不存在就算了）
  let real = null;
  try { real = P.join(realpathSync(P.dirname(abs)), P.basename(abs)); } catch {}
  return { P, abs, real };
}

/**
 * 写类工具要写的是不是成员自己的系统文件。是 → 返回给人看的拒绝理由；不是 → null。
 *   · .bridge 顶层的文件（routines.json、权限模式、会话偏好、项目表……）
 *   · .bridge/claude 顶层的文件（CLI 的 .claude.json、settings.json、凭据）
 *   · .bridge/claude/projects 下的对话记录（*.jsonl）：改了能篡改记账的起点（runtime/usage-ledger.mjs）
 * @param {string} name 工具名
 * @param {object} input 工具入参
 * @param {string} dataDir 这个身份的 .bridge 目录（ctx.dataDir）
 * @param {string} cwd 这一轮的工作目录（相对路径按它解析）
 */
export function systemWriteViolation(name, input, dataDir, cwd, platform = process.platform) {
  if (!dataDir) return null;
  const t = writeTarget(name, input, cwd || dataDir, platform);
  if (!t) return null;
  const { P } = t;
  const hit = (target) => {
    const rel = P.relative(P.resolve(dataDir), target);
    if (!rel || rel.startsWith('..') || P.isAbsolute(rel)) return false;
    const parts = rel.split(P.sep).filter(Boolean);
    const norm = platform === 'win32' ? parts.map((x) => x.toLowerCase()) : parts;
    if (norm.length === 1 || (norm.length === 2 && norm[0] === 'claude')) return true;
    return norm[0] === 'claude' && norm[1] === 'projects' && norm[norm.length - 1].endsWith('.jsonl');
  };
  if (hit(t.abs) || (t.real && hit(t.real))) return SYSTEM_WRITE_MSG;
  return null;
}

/**
 * 没有命令行的成员：agent 的写类工具不许碰 git 仓库的内部文件——路径里任何一段叫 .git（.git 目录里的
 * config / hooks / info，以及 worktree 用的那个 .git 指针文件）。
 * 为什么：成员自己跑不了 git，但工作台的「审阅」会由服务端在他的目录里跑 git status / diff，而仓库自己的配置
 * （core.fsmonitor、diff.external、签名程序、过滤器……）能让 git 执行任意命令——等于借服务端的手绕过「没有命令行」。
 * 服务端那一侧也要用 memberGitArgs / memberGitEnv 跑 git（见下面），这里是 agent 这一侧的闸。
 */
export function gitInternalsViolation(name, input, cwd, platform = process.platform) {
  const t = writeTarget(name, input, cwd, platform);
  if (!t) return null;
  const isGit = (p) => String(p).split(/[\\/]+/).some((seg) => (platform === 'win32' ? seg.toLowerCase() : seg) === '.git');
  return isGit(t.abs) || (t.real && isGit(t.real)) ? GIT_WRITE_MSG : null;
}

// ---- 服务端替成员跑 git 时（工作台审阅、worktree、PR）用：仓库是成员自己能写的，配置不可信 ----
// 覆盖仓库配置里能让 git 执行命令的几项：fsmonitor、钩子、签名与验签程序（log.showSignature 会让 git log 去调它）、
// ssh 命令、ext 协议；裸仓库只认显式指定的（防「目录里摆一套 HEAD / config 冒充仓库」）。
// 「不执行」的写法要选 git 认得的值：指到空设备（NUL / /dev/null，没人能在那儿摆程序），sshCommand 回到默认的 ssh。
// 空串不行——git 会去执行一个空命令，整条命令直接报错（cannot spawn）。
// 外部 diff（diff.external）没有能关掉它的配置值，只能靠命令行开关：diff 类命令一律加 MEMBER_GIT_DIFF_FLAGS
// （--no-ext-diff 同时管住 diff.<驱动>.command，--no-textconv 管住 textconv）。CLI 自己跑的 diff 已经带了这两个开关
// 或只取 --numstat / --name-only，不走外部 diff。
// 环境变量按有命令行的成员剔除（凭据不进 git 与它可能拉起的任何东西）；系统级与服务器账户自己的 git 配置
// （换行符转换、凭据助手）是部署者的，照常读。注意 core.sshCommand 这里固定成 ssh，部署者全局配置里的同名项也被盖掉：
// 替成员推送要指定密钥的，请改用环境变量 GIT_SSH_COMMAND（它优先于一切 core.sshCommand，照常传下去）。
// 管不到的：仓库自定义的 filter（.gitattributes + filter.<名>.clean，git status 也可能跑）、仓库里配的凭据助手
// （credential.helper，推拉时才会调）、include.path 引进来的同类配置——没有总开关。所以真正的防线是成员写不进 .git：
// agent 这一侧由 gitInternalsViolation 挡住，上传 / 文件接口那一侧也要挡。
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const MEMBER_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NULL_DEVICE],
  ['safe.bareRepository', 'explicit'],
  ['core.sshCommand', 'ssh'],
  ['protocol.ext.allow', 'never'],
  ['log.showSignature', 'false'],
  ['gpg.program', NULL_DEVICE],
  ['gpg.openpgp.program', NULL_DEVICE],
  ['gpg.ssh.program', NULL_DEVICE],
  ['gpg.x509.program', NULL_DEVICE],
  ['commit.gpgSign', 'false'],
  ['tag.gpgSign', 'false'],
]);
export const memberGitArgs = Object.freeze(MEMBER_GIT_CONFIG.flatMap(([k, v]) => ['-c', k + '=' + v]));
/** diff / show / log -p 这类会出补丁的命令，放在子命令后面。 */
export const MEMBER_GIT_DIFF_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv']);
// 同一组覆盖的环境变量写法（git 2.31 起认 GIT_CONFIG_COUNT / KEY_n / VALUE_n，优先级同 -c）：给不经我们拼参数、
// 自己去跑 git 的子进程用。注意 Claude CLI 取 git 状态那几条会把这些变量剥掉换成自己的，所以没有命令行的身份
// 另外用 CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS 关掉那一步（见 memberEngineBase）；这里管的是其余直接继承环境的 git。
export function memberGitConfigEnv() {
  const out = { GIT_CONFIG_COUNT: String(MEMBER_GIT_CONFIG.length) };
  MEMBER_GIT_CONFIG.forEach(([k, v], i) => { out['GIT_CONFIG_KEY_' + i] = k; out['GIT_CONFIG_VALUE_' + i] = v; });
  return out;
}
export const memberGitEnv = (src = process.env) => ({ ...memberProcessEnv(src, { shell: true }), GIT_TERMINAL_PROMPT: '0' });

// 服务端替某个工作目录跑 git 时的参数与环境（工作台审阅 routes/claude-dock.mjs、worktree claude-worktrees.mjs、
// PR runtime/pr-git.mjs、会话家族 runtime/session-family.mjs 共用）：
//   · 目录在用户根或快照桶下面（成员的，isMemberPath）→ 子命令前加 memberGitArgs，diff / show / log 在子命令后加
//     MEMBER_GIT_DIFF_FLAGS，环境换成 memberGitEnv（剔凭据、带 GIT_CEILING_DIRECTORIES）；
//   · 主机自己的目录 → 原样（老行为）。
// args 是 git 后面的全部参数（可以带 -c k=v / -C 目录 这类全局参数在前）；extraEnv 是 GIT_OPTIONAL_LOCKS 这类无害开关。
const PATCH_SUBCMDS = new Set(['diff', 'show', 'log']);
export function gitInvocation(cwd, args, baseEnv = process.env, extraEnv = {}) {
  const list = [...(args || [])];
  if (!isMemberPath(cwd)) return { args: list, env: { ...baseEnv, ...extraEnv } };
  let i = 0;
  while (i < list.length) {
    const a = String(list[i]);
    if (a === '-c' || a === '-C') { i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const out = PATCH_SUBCMDS.has(list[i]) ? [...list.slice(0, i + 1), ...MEMBER_GIT_DIFF_FLAGS, ...list.slice(i + 1)] : list;
  return { args: [...memberGitArgs, ...out], env: { ...memberGitEnv(baseEnv), ...extraEnv } };
}
