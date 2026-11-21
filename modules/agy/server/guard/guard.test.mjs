// 注册用户 agy 进程的工具调用守卫：判定口径（policy.mjs）、钩子脚本的失败即拒绝（guard-hook.cjs）、安装（install.mjs）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-guard-'));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
const { guardDecision, agyPathReadings } = await import('./policy.mjs');
const { installGuard, GUARD_HOOK_NAME } = await import('./install.mjs');

after(() => { rmSync(tmp, { recursive: true, force: true }); });

const home = path.join(tmp, 'users', 'alice');
const sys = path.join(home, '.bridge');
const brain = path.join(tmp, 'tenant', 'antigravity-cli', 'brain');
for (const d of [home, path.join(home, 'proj'), path.join(sys, 'uploads'), path.join(sys, 'agy'), brain, path.join(tmp, 'users', 'bob')]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(home, 'proj', 'a.txt'), 'mine');
writeFileSync(path.join(tmp, 'users', 'bob', 'secret.txt'), 'not yours');

const member = (shell) => ({ kind: 'user', user: 'alice', key: 'u:alice', sandbox: true, shell, cwd: home, dataDir: sys, allowAgy: true });
const call = (ctx, name, args) => guardDecision(ctx, { toolCall: { name, args } }, { artifactDirs: [brain] });
const denied = (r) => !!r && r.decision === 'deny';
const win = process.platform === 'win32';
const outsideAbs = win ? 'C:\\Windows\\win.ini' : '/etc/passwd';

test('文件类工具：自己文件夹里的不表态，别处的一律拒；从不返回 allow', () => {
  const ctx = member(false);
  assert.equal(call(ctx, 'read_file', { Path: path.join(home, 'proj', 'a.txt') }), null);
  assert.equal(call(ctx, 'write_file', { Path: path.join(home, 'proj', 'new.txt'), Content: 'x' }), null);
  assert.equal(call(ctx, 'read_file', { Path: path.join(brain, 'sid', 'img.png') }), null, '这个进程自己的产物目录可以读');
  assert.ok(denied(call(ctx, 'read_file', { Path: outsideAbs })));
  assert.ok(denied(call(ctx, 'read_file', { Path: path.join(tmp, 'users', 'bob', 'secret.txt') })), '别的用户的文件夹');
  assert.ok(denied(call(ctx, 'read_file', { Path: path.join(tmp, 'data', 'config.json') })), '服务端数据目录');
  assert.ok(denied(call(ctx, 'edit_file', { Path: outsideAbs, Target: 'a', Replacement: 'b' })));
  assert.ok(denied(call(ctx, 'read_file', {})), '没给路径的文件操作不放');
  for (const r of [call(ctx, 'read_file', { Path: path.join(home, 'proj', 'a.txt') }), call(ctx, 'search_web', { query: 'x' })]) {
    assert.notEqual(r?.decision, 'allow');
  }
});

test('路径的各种写法：盘符前带斜杠、file://、相对路径、不带盘符的根路径、.. 穿越、百分号编码的穿越', () => {
  const ctx = member(false);
  const inside = path.join(home, 'proj', 'a.txt');
  const slashed = '/' + inside.replace(/\\/g, '/');
  if (win) {
    assert.equal(call(ctx, 'read_file', { Path: slashed }), null, '/C:/… 是 agy 常用的写法，落在里面就放');
    assert.equal(call(ctx, 'read_file', { Path: 'file:///' + inside.replace(/\\/g, '/') }), null);
    assert.ok(denied(call(ctx, 'read_file', { Path: '/C:/Windows/win.ini' })));
    assert.ok(denied(call(ctx, 'read_file', { Path: 'file:///C:/Windows/win.ini' })));
    assert.ok(denied(call(ctx, 'read_file', { Path: '\\Windows\\win.ini' })), '不带盘符的根路径说不清落在哪个盘');
    assert.ok(denied(call(ctx, 'read_file', { Path: '/Windows/win.ini' })), '不能照 Claude 沙箱那样当成相对工作区');
    assert.ok(denied(call(ctx, 'read_file', { Path: '\\\\?\\C:\\Windows\\win.ini' })));
    assert.ok(denied(call(ctx, 'read_file', { Path: '\\\\server\\share\\x.txt' })));
  }
  assert.ok(denied(call(ctx, 'read_file', { Path: 'proj/a.txt' })), '相对路径不放');
  assert.ok(denied(call(ctx, 'read_file', { Path: path.join(home, 'proj', '..', '..', 'bob', 'secret.txt') })));
  const enc = path.join(home, 'proj') + path.sep + '%2e%2e' + path.sep + '%2e%2e' + path.sep + 'bob' + path.sep + 'secret.txt';
  assert.ok(denied(call(ctx, 'read_file', { Path: enc })), '解码后出界的也要拦');
  const twice = path.join(home, 'proj') + path.sep + '%252e%252e' + path.sep + '%252e%252e' + path.sep + 'bob' + path.sep + 'secret.txt';
  assert.ok(denied(call(ctx, 'read_file', { Path: twice })), '套两层编码的');
  assert.equal(agyPathReadings('not/absolute'), null);
  // 别的参数名里的路径同样过围栏
  assert.ok(denied(call(ctx, 'grep_search', { SearchPath: outsideAbs, Query: 'x' })));
  assert.ok(denied(call(ctx, 'write_to_file', { TargetFile: outsideAbs })));
});

test('写类：bridge 保管的系统数据不许改（上传与媒体除外）；没有命令行权限的不许写会被执行的位置', () => {
  const noShell = member(false);
  assert.ok(denied(call(noShell, 'write_file', { Path: path.join(sys, 'routines.json') })));
  assert.ok(denied(call(noShell, 'edit_file', { Path: path.join(sys, 'agy', 'settings.json') })));
  assert.ok(denied(call(noShell, 'write_file', { Path: path.join(sys, 'claude', 'settings.json') })));
  assert.equal(call(noShell, 'write_file', { Path: path.join(sys, 'uploads', 'x.png') }), null);
  assert.equal(call(noShell, 'read_file', { Path: path.join(sys, 'agy', 'settings.json') }), null, '读自己的系统数据不拦');
  for (const p of [['.agents', 'hooks.json'], ['proj', '.agent', 'hooks.json'], ['proj', '_agents', 'skills', 's', 'SKILL.md'], ['proj', '.git', 'config']]) {
    assert.ok(denied(call(noShell, 'write_file', { Path: path.join(home, ...p) })), p.join('/'));
  }
  const withShell = member(true);
  assert.equal(call(withShell, 'write_file', { Path: path.join(home, '.agents', 'hooks.json') }), null, '有命令行权限的本来就能执行命令');
  assert.ok(denied(call(withShell, 'write_file', { Path: path.join(sys, 'routines.json') })), '系统数据对谁都不许改');
});

test('跑命令：没有命令行权限的一律拒；有的过字符串筛查；后台任务喂输入同理', () => {
  const noShell = member(false);
  assert.ok(denied(call(noShell, 'run_command', { CommandLine: 'echo hi' })));
  assert.ok(denied(call(noShell, 'manage_task', { Action: 'send_input', TaskId: 't', Input: 'y' })));
  assert.equal(call(noShell, 'manage_task', { Action: 'list' }), null);
  const withShell = member(true);
  assert.equal(call(withShell, 'run_command', { CommandLine: 'npm test' }), null);
  assert.ok(denied(call(withShell, 'run_command', { CommandLine: win ? 'type C:\\Windows\\win.ini' : 'cat /etc/passwd' })));
  assert.ok(denied(call(withShell, 'run_command', { CommandLine: 'cat ../../bob/secret.txt' })));
  assert.ok(denied(call(withShell, 'run_command', { CommandLine: 'echo hi', Cwd: outsideAbs })), '命令的工作目录也要在围栏里');
});

test('其余工具：没有路径语义的与 bridge 自己的不表态；不认识的、不该给的一律拒；身份不对一律拒', () => {
  const ctx = member(false);
  for (const name of ['ask_question', 'search_web', 'invoke_subagent', 'send_message', 'manage_subagents', 'generate_image', 'mcp_bridge_browser', 'mcp_bridge_media_image']) {
    assert.equal(call(ctx, name, { Prompt: 'x' }), null, name);
  }
  for (const name of ['schedule', 'run_workflow', 'swarm', 'some_future_tool', 'mcp_other_server_tool', 'mcp_bridge_abc12345_browser'.toUpperCase() + ' x']) {
    assert.ok(denied(call(ctx, name, {})), name);
  }
  assert.ok(denied(guardDecision(null, { toolCall: { name: 'search_web' } })));
  assert.ok(denied(guardDecision({ kind: 'admin', cwd: home }, { toolCall: { name: 'search_web' } })), '守卫只给注册用户的进程判');
  assert.ok(denied(guardDecision(ctx, {})), '认不出工具');
});

test('绕写法：段尾的点与空格、备用数据流、短名、目录联接都过不了「系统数据不许改」和围栏', () => {
  const ctx = member(true);
  if (win) {
    for (const seg of ['.bridge.', '.bridge ', '.bridge::$INDEX_ALLOCATION', 'BRIDGE~1']) {
      assert.ok(denied(call(ctx, 'write_file', { Path: home + path.sep + seg + path.sep + 'routines.json' })), seg);
    }
    assert.ok(denied(call(ctx, 'read_file', { Path: path.join(home, 'proj', 'a.txt') + '::$DATA' })));
    assert.ok(denied(call(ctx, 'write_file', { Path: path.join(home, '.BRIDGE', 'routines.json') })), '大小写不同还是那个目录');
  }
  // 自己文件夹里建一个指向别处的目录联接：往里读已有的、写还不存在的，都按真实位置判
  const toSys = path.join(home, 'link-sys');
  const toBob = path.join(home, 'link-bob');
  let linked = true;
  try {
    symlinkSync(sys, toSys, 'junction');
    symlinkSync(path.join(tmp, 'users', 'bob'), toBob, 'junction');
  } catch { linked = false; }
  if (linked) {
    assert.ok(denied(call(ctx, 'write_file', { Path: path.join(toSys, 'routines.json') })), '经联接改系统数据');
    assert.ok(denied(call(ctx, 'read_file', { Path: path.join(toBob, 'secret.txt') })), '经联接读别人的文件');
    assert.ok(denied(call(ctx, 'write_file', { Path: path.join(toBob, 'new-file.txt') })), '经联接往外面写新文件（目标还不存在）');
    assert.ok(denied(call(ctx, 'write_file', { Path: path.join(toBob, 'new-dir', 'deep', 'x.txt') })));
  }
  assert.equal(call(ctx, 'write_file', { Path: path.join(home, 'proj', 'brand-new', 'x.txt') }), null, '自己文件夹里还不存在的位置照常能写');
});

test('命令与别的工具里夹带的东西：取不到命令原文不放、喂输入照样过筛、哈希名的 bridge 工具不认、参考图与抓取地址过围栏', () => {
  const withShell = member(true);
  assert.ok(denied(call(withShell, 'run_command', { Cmd: 'type C:\\Windows\\win.ini' })), '换了参数名：认不出命令就不放');
  assert.ok(denied(call(withShell, 'run_command', {})));
  assert.equal(call(withShell, 'manage_task', { Action: 'send_input', TaskId: 't', Input: 'y' }), null);
  assert.ok(denied(call(withShell, 'manage_task', { Action: 'send_input', TaskId: 't', Input: win ? 'type C:\\Windows\\win.ini' : 'cat /etc/passwd' })));
  assert.ok(denied(call(withShell, 'send_command_input', { Input: win ? 'type C:\\Windows\\win.ini' : 'cat /etc/passwd' })));

  const ctx = member(false);
  assert.ok(denied(call(ctx, 'mcp_bridge_abc12345_browser', {})), 'agy 给同名的另一份服务起的哈希名');
  assert.equal(call(ctx, 'mcp_bridge_browser', {}), null);

  assert.ok(denied(call(ctx, 'generate_image', { Prompt: 'x', ImagePaths: [outsideAbs] })), '参考图在外面');
  assert.ok(denied(call(ctx, 'generate_image', { Prompt: 'x', ImagePaths: [path.join(home, 'proj', 'a.txt'), path.join(tmp, 'users', 'bob', 'secret.txt')] })));
  assert.equal(call(ctx, 'generate_image', { Prompt: `照 ${outsideAbs} 的风格画`, ImagePaths: [path.join(home, 'proj', 'a.txt')] }), null, '说明文字里提到路径不算');
  assert.equal(call(ctx, 'read_url_content', { Url: 'https://example.com/a?b=1' }), null);
  for (const u of ['file:///C:/Windows/win.ini', 'file:///etc/passwd', 'http://127.0.0.1:8787/api/admin/status', 'http://localhost:8787/', 'http://[::1]/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/', 'ftp://example.com/x', 'not a url']) {
    assert.ok(denied(call(ctx, 'read_url_content', { Url: u })), u);
  }
});

test('守卫探活：有工具从开始走到执行完、守卫却没被问过才算失效；回放的旧调用、被问过的都不算', async () => {
  const { makeGuardWatch, noteGuardHit, guardBroken, markGuardBroken, _resetGuardLivenessForTest } = await import('./liveness.mjs');
  _resetGuardLivenessForTest();
  const ev = (type, id, status) => ({ type, tool: { toolCallId: id, status, name: 'read_file' } });

  let watch = makeGuardWatch('u:alice');
  assert.equal(watch(ev('tool', 'old', 'completed')), false, '载入历史时回放的：没见过它开始');
  assert.equal(watch(ev('tool', 't1', 'pending')), false);
  assert.equal(watch(ev('tool-update', 't1', 'failed')), false, '被拒 / 出错的不算执行完');
  assert.equal(watch(ev('tool', 't2', 'in_progress')), false);
  assert.equal(watch(ev('tool-update', 't2', 'completed')), true, '执行完了却没人来问过');

  watch = makeGuardWatch('u:alice');
  watch(ev('tool', 't3', 'pending'));
  noteGuardHit('u:alice');
  assert.equal(watch(ev('tool-update', 't3', 'completed')), false, '问过就是活的');
  noteGuardHit('u:bob');
  watch = makeGuardWatch('u:alice');
  watch(ev('tool', 't4', 'pending'));
  assert.equal(watch(ev('tool-update', 't4', 'completed')), true, '别人的守卫被问过不算数');

  assert.equal(guardBroken('u:alice'), '');
  const quiet = console.error; console.error = () => {};
  try { markGuardBroken('u:alice', 'test'); } finally { console.error = quiet; }
  assert.equal(guardBroken('u:alice'), 'test');
  _resetGuardLivenessForTest();
});

// —— 钩子脚本：真起一个进程喂标准输入 ——
function runHook(configDir, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(configDir, 'guard-hook.cjs')], { cwd: configDir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('钩子脚本：照 bridge 的结论输出；bridge 不应答、回错、回的不是结论时一律非零退出（agy 把钩子失败当成不执行）', async () => {
  let mode = 'pass';
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, agent: req.headers['x-bridge-agent'], body: JSON.parse(body || '{}') });
      if (mode === 'http500') { res.writeHead(500); res.end('boom'); return; }
      if (mode === 'garbage') { res.writeHead(200); res.end('not json'); return; }
      if (mode === 'notok') { res.writeHead(200); res.end(JSON.stringify({ ok: false })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, out: mode === 'deny' ? { decision: 'deny', reason: '不行' } : null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const configDir = path.join(tmp, 'tenant', 'config');
  const { command } = installGuard({ configDir, api, token: 'dvt1.agy.x.y' });

  // 安装产物：全局钩子对所有工具生效、令牌不进 hooks.json
  const hooks = JSON.parse(readFileSync(path.join(configDir, 'hooks.json'), 'utf8'));
  assert.equal(hooks[GUARD_HOOK_NAME].PreToolUse[0].matcher, '*');
  assert.equal(hooks[GUARD_HOOK_NAME].PreToolUse[0].hooks[0].command, command);
  assert.ok(!readFileSync(path.join(configDir, 'hooks.json'), 'utf8').includes('dvt1'));
  assert.ok(existsSync(path.join(configDir, win ? 'guard.cmd' : 'guard.sh')));

  const payload = { conversationId: 'c1', toolCall: { name: 'read_file', args: { Path: 'x' } } };
  const pass = await runHook(configDir, payload);
  assert.equal(pass.code, 0);
  assert.equal(pass.out, '', '不表态时什么都不输出');
  assert.equal(seen[0].url, '/api/agy/internal/guard');
  assert.equal(seen[0].auth, 'Bearer dvt1.agy.x.y');
  assert.equal(seen[0].agent, 'agy');
  assert.equal(seen[0].body.payload.toolCall.name, 'read_file');

  mode = 'deny';
  const no = await runHook(configDir, payload);
  assert.equal(no.code, 0);
  assert.deepEqual(JSON.parse(no.out), { decision: 'deny', reason: '不行' });
  assert.ok(/^[\x20-\x7e]*$/.test(no.out), '写给 agy 的结论只能有 ASCII（Windows 上它按系统代码页读，直接写中文会读坏）');
  for (const r of [await runHook(configDir, 'not json at all')]) assert.ok(/^[\x00-\x7e]*$/.test(r.err), '报错也只用 ASCII');

  for (const m of ['http500', 'garbage', 'notok']) {
    mode = m;
    const r = await runHook(configDir, payload);
    assert.notEqual(r.code, 0, m);
    assert.equal(r.out, '', m + ' 不能输出任何结论');
  }
  mode = 'pass';
  assert.notEqual((await runHook(configDir, 'not json at all')).code, 0, '调用内容坏了');

  await new Promise((r) => server.close(r));
  const down = await runHook(configDir, payload);
  assert.notEqual(down.code, 0, 'bridge 连不上');
  assert.equal(down.out, '');

  // 配置丢了
  rmSync(path.join(configDir, 'guard.json'));
  assert.notEqual((await runHook(configDir, payload)).code, 0);
});
