// 成员边界（开源路线 S2-5）的契约：成员身份的 Claude CLI / 终端拿不到服务进程环境里的凭据；
// 没有命令行的走白名单、家目录指到自己的目录；有命令行的按名字剔除；CLI 认证要的那一份单独带上；
// agent 的写类工具不许改自己的系统数据（.bridge 顶层文件与 .bridge/claude 顶层文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-member-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const mb = await import('./runtime/member-boundary.mjs');
const { claudeEngineEnv } = await import('./runtime/claude-account.mjs');
const { NATIVE_ROOT, ROOT } = await import('./config/index.mjs');

const SRC = {
  PATH: '/usr/bin', SystemRoot: 'C:\\Windows', LANG: 'zh_CN.UTF-8', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost',
  HOME: '/home/host', USERPROFILE: 'D:\\profiles\\host', TEMP: '/tmp',
  GEMINI_API_KEY: 'g-secret', DEEPSEEK_API_KEY: 'd-secret', OPENAI_API_KEY: 'o-secret', GITHUB_TOKEN: 'gh-secret', GITHUB_PAT: 'pat',
  BRIDGE_TOKEN: 'master', BRIDGE_DATA_ROOT: '/data', DATABASE_URL: 'postgres://u:p@h/db', AWS_SECRET_ACCESS_KEY: 'aws',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', ANTHROPIC_API_KEY: 'sk-ant-api-y', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', ANTHROPIC_MODEL: 'opus',
  DISABLE_AUTOUPDATER: '1', MAX_THINKING_TOKENS: '1000', SOME_TOOL_SETTING: 'keep-me', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=x',
  // 服务进程若是从某个 Claude Code 会话里起的：那个会话的通道与身份
  CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\host', CLAUDE_CODE_USER_EMAIL: 'boss@example.com', CLAUDE_CODE_HOST_SESSION_ID: 'h1', CLAUDE_AGENT_SDK_VERSION: '0.3',
};
const HOST_SESSION_KEYS = ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_USER_EMAIL', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION'];

test('白名单（没有命令行）：只留系统必需项与 Claude Code 开关，凭据一个都不带', () => {
  const env = mb.memberProcessEnv(SRC, { shell: false });
  for (const k of ['PATH', 'SystemRoot', 'LANG', 'HTTPS_PROXY', 'NO_PROXY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'ANTHROPIC_MODEL', 'DISABLE_AUTOUPDATER', 'MAX_THINKING_TOKENS']) {
    assert.equal(env[k], SRC[k], k + ' 应保留');
  }
  for (const k of ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_PAT', 'BRIDGE_TOKEN', 'BRIDGE_DATA_ROOT', 'DATABASE_URL',
    'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SOME_TOOL_SETTING', 'OTEL_EXPORTER_OTLP_HEADERS', ...HOST_SESSION_KEYS]) {
    assert.equal(env[k], undefined, k + ' 不该带');
  }
});

test('白名单 + 家目录：HOME / USERPROFILE / TEMP 指到他自己的目录（目录会建好）', () => {
  const home = path.join(tmp, 'users', 'dora', '.bridge', 'home');
  const env = mb.memberProcessEnv(SRC, { shell: false, home });
  assert.equal(env.HOME, home);
  assert.equal(env.TEMP, path.join(tmp, 'users', 'dora', '.bridge', 'tmp'));
  assert.equal(env.TMPDIR, env.TEMP);
  if (process.platform === 'win32') {
    assert.equal(env.USERPROFILE, home);
    assert.ok(env.APPDATA.startsWith(home));
  }
  assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'HOME').length, 1, '大小写不同的旧键不留');
});

test('剔除（有命令行）：照常继承，但凭据样的名字与 bridge 内部变量去掉', () => {
  const env = mb.memberProcessEnv(SRC, { shell: true });
  assert.equal(env.HOME, SRC.HOME);
  assert.equal(env.SOME_TOOL_SETTING, 'keep-me');
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000', 'TOKENS 复数不算凭据');
  for (const k of ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'BRIDGE_TOKEN', 'BRIDGE_DATA_ROOT', 'DATABASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', ...HOST_SESSION_KEYS]) {
    assert.equal(env[k], undefined, k + ' 不该带');
  }
});

test('CLI 认证单独带：订阅令牌 / API Key；云厂商形态带对应凭据、不重定向家目录', () => {
  assert.deepEqual(mb.claudeAuthCarry(SRC), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', ANTHROPIC_API_KEY: 'sk-ant-api-y' });
  const cloud = { ...SRC, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' };
  const carry = mb.claudeAuthCarry(cloud);
  assert.equal(carry.AWS_SECRET_ACCESS_KEY, 'aws');
  assert.equal(carry.AWS_REGION, 'us-east-1');
  const env = mb.memberProcessEnv(cloud, { shell: false, home: path.join(tmp, 'h2') });
  assert.equal(env.HOME, undefined, '云厂商形态的凭据在家目录里，不重定向');
});

test('claudeEngineEnv：成员拿不到服务进程环境里的其它凭据；管理员照旧', () => {
  process.env.GEMINI_API_KEY = 'g-secret-live';
  process.env.BRIDGE_SOME_SECRET = 'x';
  try {
    const dataDir = path.join(NATIVE_ROOT, 'dora', '.bridge');
    mkdirSync(dataDir, { recursive: true });
    const member = claudeEngineEnv({ kind: 'user', sandbox: true, shell: false, configDir: path.join(dataDir, 'claude'), dataDir });
    assert.equal(member.GEMINI_API_KEY, undefined);
    assert.equal(member.BRIDGE_SOME_SECRET, undefined);
    assert.equal(member.CLAUDE_CONFIG_DIR, path.join(dataDir, 'claude'));
    assert.ok(member.PATH || member.Path, 'PATH 还在');
    assert.ok(String(member.HOME).startsWith(dataDir));
    const pro = claudeEngineEnv({ kind: 'user', sandbox: true, shell: true, configDir: path.join(dataDir, 'claude'), dataDir });
    assert.equal(pro.GEMINI_API_KEY, undefined);
    assert.notEqual(String(pro.HOME || pro.USERPROFILE || ''), path.join(dataDir, 'home'), '有命令行的不改家目录');
    const admin = claudeEngineEnv({ kind: 'admin', sandbox: false });
    assert.equal((admin || process.env).GEMINI_API_KEY, 'g-secret-live', '管理员不受影响');
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.BRIDGE_SOME_SECRET;
  }
});

test('终端：成员工作区（属主不是主机、或在用户根下）剔除凭据；主机的照旧', () => {
  const src = { PATH: 'p', GITHUB_TOKEN: 't', HOME: 'h' };
  assert.equal(mb.terminalEnv(path.join(NATIVE_ROOT, 'dora'), src).GITHUB_TOKEN, undefined);
  assert.equal(mb.terminalEnv(path.join(tmp, 'workspace'), src, { owner: 'u:dora' }).GITHUB_TOKEN, undefined);
  assert.equal(mb.terminalEnv(path.join(tmp, 'workspace'), src).GITHUB_TOKEN, 't');
  assert.equal(mb.terminalEnv(path.join(tmp, 'workspace'), src, { owner: 'admin' }).GITHUB_TOKEN, 't');
});

test('系统文件写保护：.bridge 顶层与 .bridge/claude 顶层的文件拒写，子目录与工作区照常', () => {
  const P = path.posix;
  const base = '/srv/users/dora';
  const dataDir = P.join(base, '.bridge');
  const v = (name, p, cwd = base) => mb.systemWriteViolation(name, { file_path: p }, dataDir, cwd, 'linux');
  assert.ok(v('Write', P.join(dataDir, 'routines.json')));
  assert.ok(v('Edit', P.join(dataDir, 'claude-permission-modes.json')));
  assert.ok(v('Write', '.bridge/routines.json'), '相对路径按 cwd 解析');
  assert.ok(v('Write', P.join(dataDir, 'claude', 'settings.json')));
  assert.ok(v('Write', P.join(dataDir, 'claude', '.claude.json')));
  assert.equal(v('Write', P.join(dataDir, 'claude', 'projects', 'p', 'memory', 'MEMORY.md')), null, '自动记忆照常写');
  assert.ok(v('Edit', P.join(dataDir, 'claude', 'projects', 'p', 'abc.jsonl')), '对话记录不许改（记账起点在里面）');
  assert.ok(v('Write', P.join(dataDir, 'claude', 'projects', 'p', 'abc', 'subagents', 'agent-1.jsonl')));
  assert.equal(v('Write', P.join(dataDir, 'quickchat', 'abc', 'notes.md')), null, '临时对话桶照常写');
  assert.equal(v('Write', P.join(dataDir, 'workspaces', 'w1', 'a.js')), null);
  assert.equal(v('Write', P.join(base, 'project', 'a.js')), null, '工作区照常写');
  assert.equal(v('Read', P.join(dataDir, 'routines.json')), null, '只读不管');
  assert.equal(mb.systemWriteViolation('NotebookEdit', { notebook_path: P.join(dataDir, 'x.ipynb') }, dataDir, base, 'linux') !== null, true);
  // 临时对话的 cwd 在 .bridge/quickchat/<id> 里：往上写 .bridge 顶层照样拦
  assert.ok(v('Write', '../../routines.json', P.join(dataDir, 'quickchat', 'abc')));
  // Windows：大小写不敏感、"/foo" 是相对工作区的写法
  const W = path.win32;
  const wb = 'D:\\members\\dora';
  const wd = W.join(wb, '.bridge');
  assert.ok(mb.systemWriteViolation('Write', { file_path: 'D:\\MEMBERS\\DORA\\.BRIDGE\\ROUTINES.JSON' }, wd, wb, 'win32'));
  assert.ok(mb.systemWriteViolation('Write', { file_path: '/.bridge/routines.json' }, wd, wb, 'win32'));
  assert.equal(mb.systemWriteViolation('Write', { file_path: '/src/a.js' }, wd, wb, 'win32'), null);
});

test('.git 内部：没有命令行的成员的 agent 不许写（仓库配置能让服务端替他跑的 git 执行命令）', () => {
  const P = path.posix;
  const base = '/srv/users/dora';
  const g = (name, p, platform = 'linux', cwd = base) => mb.gitInternalsViolation(name, { [name === 'NotebookEdit' ? 'notebook_path' : 'file_path']: p }, cwd, platform);
  assert.ok(g('Write', P.join(base, 'proj', '.git', 'config')));
  assert.ok(g('Edit', 'proj/.git/hooks/post-checkout'), '相对路径按 cwd 解析');
  assert.ok(g('Write', P.join(base, 'proj', '.git')), 'worktree 的 .git 指针文件');
  assert.ok(g('MultiEdit', P.join(base, 'proj', '.git', 'info', 'attributes')));
  assert.equal(g('Write', P.join(base, 'proj', '.gitignore')), null, '.gitignore 照常写');
  assert.equal(g('Write', P.join(base, 'proj', '.github', 'workflows', 'ci.yml')), null);
  assert.equal(g('Write', P.join(base, 'proj', 'src', 'a.js')), null);
  assert.equal(g('Read', P.join(base, 'proj', '.git', 'config')), null, '只读不管');
  assert.ok(g('Write', 'D:\\Members\\Dora\\Proj\\.GIT\\config', 'win32', 'D:\\Members\\Dora'), 'Windows 大小写不敏感');
});

test('服务端替成员跑 git：-c 关掉仓库配置里能执行命令的几项，环境变量剔掉凭据', () => {
  const args = mb.memberGitArgs.join(' ');
  for (const k of ['core.fsmonitor=false', 'safe.bareRepository=explicit', 'core.hooksPath=', 'log.showSignature=false', 'gpg.program=', 'gpg.openpgp.program=',
    'gpg.ssh.program=', 'gpg.x509.program=', 'core.sshCommand=ssh', 'commit.gpgSign=false']) assert.ok(args.includes(k), k);
  assert.ok(!args.includes('diff.external'), 'diff.external 没有「关掉」的值（空串会让 git diff 直接报错），交给 --no-ext-diff');
  assert.ok(!/=( |$)/.test(args), '没有空值（git 会把空串当命令去执行）');
  assert.deepEqual([...mb.MEMBER_GIT_DIFF_FLAGS], ['--no-ext-diff', '--no-textconv']);
  const env = mb.memberGitEnv({ PATH: 'p', HOME: 'h', GITHUB_TOKEN: 't', BRIDGE_TOKEN: 'b' });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.BRIDGE_TOKEN, undefined);
  assert.equal(env.HOME, 'h', '服务器账户自己的 git 配置照常读');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  // 同一组覆盖的环境变量写法，与 -c 一一对应
  const ge = mb.memberGitConfigEnv();
  const n = Number(ge.GIT_CONFIG_COUNT);
  assert.equal(mb.memberGitArgs.length, n * 2);
  const pairs = Array.from({ length: n }, (_, i) => ge['GIT_CONFIG_KEY_' + i] + '=' + ge['GIT_CONFIG_VALUE_' + i]);
  assert.deepEqual(pairs, mb.memberGitArgs.filter((_, i) => i % 2 === 1));
});

test('没有命令行的成员的 Claude CLI：环境里带 git 配置覆盖（CLI 自己在他目录里跑的 git 不执行仓库里埋的命令）', () => {
  const dataDir = path.join(NATIVE_ROOT, 'gina', '.bridge');
  mkdirSync(dataDir, { recursive: true });
  const member = claudeEngineEnv({ kind: 'user', sandbox: true, shell: false, configDir: path.join(dataDir, 'claude'), dataDir });
  assert.equal(member.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(Number(member.GIT_CONFIG_COUNT), Number(mb.memberGitConfigEnv().GIT_CONFIG_COUNT));
  // CLI 取 git 状态时不认天花板、还会剥掉 GIT_CONFIG_*：没有命令行的直接关掉这一步（离线冒烟实测：不关会把宿主仓库的
  // 分支、改动文件名、最近提交写进系统提示；关了就没有）
  assert.equal(member.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, '1');
  const pro = claudeEngineEnv({ kind: 'user', sandbox: true, shell: true, configDir: path.join(dataDir, 'claude'), dataDir });
  assert.equal(pro.GIT_CONFIG_KEY_0, undefined, '有命令行的不加（他本来就能跑任何东西）');
  assert.equal(pro.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, undefined);

  // 真跑一次：仓库 config 里埋 core.fsmonitor，带覆盖的 git status 不执行它；对照组（不带）确实执行
  let gitOk = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
  if (!gitOk) return;
  const repo = path.join(tmp, 'evil-repo');
  const marker = path.join(tmp, 'fsmonitor-ran.txt');
  const g = (args, env = process.env) => execFileSync('git', args, { cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).toString();
  mkdirSync(repo, { recursive: true });
  g(['init', '-q']);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const evil = path.join(tmp, 'evil.cjs');
  writeFileSync(evil, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x\\n'); process.exit(0);`);
  const cmd = `"${process.execPath.replace(/\\/g, '/')}" "${evil.replace(/\\/g, '/')}"`;
  appendFileSync(path.join(repo, '.git', 'config'), `[core]\n\tfsmonitor = ${cmd.replace(/"/g, '\\"')}\n`);
  g(['status', '--porcelain'], { ...process.env, ...mb.memberGitConfigEnv() });
  assert.equal(existsSync(marker), false, '带覆盖：没执行');
  try { g(['status', '--porcelain']); } catch {}
  assert.equal(existsSync(marker), true, '对照组：确实会执行（证明上面那条断言有意义）');
});

// 真跑 git 的小工具：返回 { code, out, err }，不抛
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function git(args, cwd, env = process.env) {
  const r = spawnSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '') };
}

test('git 覆盖：仓库里埋的验签程序（log.showSignature + gpg.program）不执行；对照组会执行', { skip: !hasGit }, () => {
  const repo = path.join(tmp, 'sig-repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'one'], repo);
  // 手工造一个带签名头的提交：git log 一看到 gpgsig 就会去调验签程序
  const tree = git(['write-tree'], repo).out;
  const parent = git(['rev-parse', 'HEAD'], repo).out;
  const objFile = path.join(tmp, 'sig-commit.txt');
  writeFileSync(objFile, `tree ${tree}\nparent ${parent}\nauthor a <a@b> 1700000000 +0000\ncommitter a <a@b> 1700000000 +0000\n`
    + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n');
  git(['update-ref', 'HEAD', git(['hash-object', '-t', 'commit', '-w', objFile], repo).out], repo);
  const marker = path.join(tmp, 'gpg-ran.txt');
  const evil = path.join(tmp, 'evil-gpg.cjs');
  writeFileSync(evil, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x\\n'); process.exit(1);`);
  // gpg.program 是直接执行的（不过 shell）：包一层脚本
  const wrapper = path.join(tmp, process.platform === 'win32' ? 'evil-gpg.bat' : 'evil-gpg.sh');
  if (process.platform === 'win32') writeFileSync(wrapper, `@"${process.execPath}" "${evil}"\r\n`);
  else writeFileSync(wrapper, `#!/bin/sh\n"${process.execPath}" "${evil}"\n`, { mode: 0o755 });
  appendFileSync(path.join(repo, '.git', 'config'), `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${wrapper.replace(/\\/g, '/')}\n`);
  const over = { ...process.env, ...mb.memberGitConfigEnv() };
  const r1 = git(['--no-optional-locks', 'log', '--oneline', '-n', '5'], repo, over);   // CLI 开会话时跑的就是这一条
  assert.equal(r1.code, 0, r1.err);
  assert.equal(existsSync(marker), false, '带覆盖：没执行');
  git(['log', '--show-signature', '-n', '1'], repo, over);
  assert.equal(existsSync(marker), false, '显式要验签也只会去调空设备');
  git(['log', '--oneline', '-n', '1'], repo);
  assert.equal(existsSync(marker), true, '对照组：确实会执行（证明上面那条断言有意义）');
});

test('git 覆盖不把普通命令弄坏：git diff 照常出补丁，ssh 远端报的是连接错误而不是 cannot spawn', { skip: !hasGit }, () => {
  const repo = path.join(tmp, 'plain-repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', 'a.txt'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  for (const [label, env, pre] of [['环境变量写法', { ...process.env, ...mb.memberGitConfigEnv() }, []], ['-c 写法', process.env, [...mb.memberGitArgs]]]) {
    const d = git([...pre, 'diff'], repo, env);
    assert.equal(d.code, 0, label + '：' + d.err);
    assert.match(d.out, /^\+two$/m, label + '：补丁照常');
    const d2 = git([...pre, 'diff', ...mb.MEMBER_GIT_DIFF_FLAGS], repo, env);
    assert.match(d2.out, /^\+two$/m, label + '：带 --no-ext-diff 也照常');
    const s = git([...pre, 'ls-remote', 'ssh://git@127.0.0.1:1/x.git'], repo, env);
    assert.notEqual(s.code, 0);
    assert.doesNotMatch(s.err, /cannot spawn\s*:/, label + '：不是去执行空命令');
  }
});

test('git 天花板：成员环境里 git 不往上找到宿主仓库，成员自己的仓库照常', { skip: !hasGit }, () => {
  const host = path.join(tmp, 'host-repo');
  const users = path.join(host, 'users');
  const deep = path.join(users, 'alice', 'proj');
  mkdirSync(deep, { recursive: true });
  git(['init', '-q'], host);
  assert.equal(git(['rev-parse', '--is-inside-work-tree'], deep).out, 'true', '对照组：不设天花板会找到宿主仓库');
  for (const shell of [false, true]) {
    const env = mb.memberProcessEnv(process.env, { shell, ceilings: [users] });
    const r = git(['rev-parse', '--is-inside-work-tree'], deep, env);
    assert.notEqual(r.code, 0, (shell ? '剔除' : '白名单') + '模式：不在仓库里');
  }
  git(['init', '-q'], path.join(users, 'alice'));
  const own = git(['rev-parse', '--show-toplevel'], deep, mb.memberProcessEnv(process.env, { shell: true, ceilings: [users] }));
  assert.equal(path.resolve(own.out), path.resolve(path.join(users, 'alice')), '成员自己的仓库照常');
});

test('git 天花板：默认是用户根与快照桶总目录，并进部署者已有的设置；终端、服务端 git、CLI 都带', () => {
  const want = [path.resolve(NATIVE_ROOT), path.resolve(path.join(ROOT, 'chat-snapshots'))];
  assert.deepEqual(mb.memberGitCeilings(), want);
  const env = mb.memberProcessEnv({ PATH: 'p', GIT_CEILING_DIRECTORIES: '/already' }, { shell: false });
  assert.deepEqual(env.GIT_CEILING_DIRECTORIES.split(path.delimiter), ['/already', ...want]);
  assert.ok(mb.terminalEnv(path.join(NATIVE_ROOT, 'dora'), { PATH: 'p' }).GIT_CEILING_DIRECTORIES.includes(want[0]));
  assert.ok(mb.memberGitEnv({ PATH: 'p' }).GIT_CEILING_DIRECTORIES.includes(want[1]));
  const dataDir = path.join(NATIVE_ROOT, 'hana', '.bridge');
  mkdirSync(dataDir, { recursive: true });
  const cli = claudeEngineEnv({ kind: 'user', sandbox: true, shell: false, configDir: path.join(dataDir, 'claude'), dataDir });
  assert.ok(String(cli.GIT_CEILING_DIRECTORIES || '').split(path.delimiter).includes(want[1]), '快照访客与普通档成员的 CLI 也带');
  assert.equal(mb.terminalEnv(path.join(tmp, 'workspace'), { PATH: 'p' }, { owner: 'admin' }).GIT_CEILING_DIRECTORIES, undefined, '主机的照旧');
});

test('服务端替工作目录跑 git（gitInvocation）：成员目录加覆盖、diff/show/log 加开关、剔凭据；主机目录原样', () => {
  const base = { PATH: 'p', GITHUB_TOKEN: 'gh-secret', BRIDGE_TOKEN: 'master', GIT_OPTIONAL_LOCKS: '0' };
  const member = path.join(NATIVE_ROOT, 'ivy', 'proj');
  const d = mb.gitInvocation(member, ['-c', 'core.quotepath=false', 'diff', '--relative', 'HEAD'], base, { X_EXTRA: '1' });
  const n = mb.memberGitArgs.length;
  assert.deepEqual(d.args.slice(0, n), [...mb.memberGitArgs]);
  assert.deepEqual(d.args.slice(n), ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--relative', 'HEAD']);
  assert.equal(d.env.GITHUB_TOKEN, undefined);
  assert.equal(d.env.BRIDGE_TOKEN, undefined);
  assert.equal(d.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(d.env.X_EXTRA, '1');
  const s = mb.gitInvocation(member, ['status', '--porcelain'], base);
  assert.deepEqual(s.args.slice(n), ['status', '--porcelain'], 'status 不加 diff 开关');
  const snapDir = path.join(ROOT, 'chat-snapshots', 'tok', 'w');
  assert.equal(mb.gitInvocation(snapDir, ['log', '-1'], base).args.slice(n).join(' '), 'log --no-ext-diff --no-textconv -1', '快照桶也算');
  const host = mb.gitInvocation(path.join(tmp, 'workspace'), ['-c', 'core.quotepath=false', 'diff'], base);
  assert.deepEqual(host.args, ['-c', 'core.quotepath=false', 'diff']);
  assert.equal(host.env.GITHUB_TOKEN, 'gh-secret', '主机的照旧');
});

test('文件接口这一侧：没有命令行的身份不许往 .git 写（目录与指针文件），有命令行的与主机照常', async () => {
  const { protectedTarget, gitGuarded } = await import('./routes/file-core.mjs');
  const root = path.join(NATIVE_ROOT, 'jun');
  const member = { kind: 'user', sandbox: true, shell: false, cwd: root };
  const full = { ...member, shell: true };
  const admin = { kind: 'admin', sandbox: false, shell: true, cwd: root };
  const rels = ['.git', '.git/config', 'proj/.git/hooks/pre-commit', ...(process.platform === 'win32' ? ['proj/.GIT/config'] : [])];
  for (const rel of rels) {
    assert.equal(protectedTarget(root, path.join(root, rel), member), true, '普通档：' + rel);
    assert.equal(protectedTarget(root, path.join(root, rel), full), false, '完全信任：' + rel);
    assert.equal(protectedTarget(root, path.join(root, rel), admin), false, '主机：' + rel);
  }
  assert.equal(protectedTarget(root, path.join(root, 'proj', '.gitignore'), member), false, '.gitignore 不算');
  assert.equal(protectedTarget(root, path.join(root, 'proj', 'a.git'), member), false);
  assert.equal(gitGuarded(null), true, '没有 ctx 按保守默认');
  assert.equal(gitGuarded({ kind: 'snap', sandbox: true, shell: false }), true, '快照访客');
});
