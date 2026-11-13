// 桌面控制的坐标帧换算与按键解析（纯函数部分；真桌面端到端见 bridge build memory 里的验证记录）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFrame, parseKeys, toFramePixels, toPhysical } from './remote-control-desktop.mjs';
import { desktopContent, shotText } from '../mcp/desktop-format.mjs';

// 5120×1440 主屏缩到 1568×441（官方同一预算）
const wide = makeFrame({ ox: 0, oy: 0, w: 5120, h: 1440, fw: 1568, fh: 441 });

test('截图像素按帧换算回物理偏移，越界与无截图直接报错', () => {
  assert.deepEqual(toPhysical(wide, 0, 0), { fx: 0, fy: 0 });
  assert.deepEqual(toPhysical(wide, 784, 220), { fx: Math.round(784 * 5120 / 1568), fy: Math.round(220 * 1440 / 441) });
  // 右下角恰好在帧边上：夹到最后一个物理像素，而不是越出屏幕
  assert.deepEqual(toPhysical(wide, 1568, 441), { fx: 5119, fy: 1439 });
  assert.throws(() => toPhysical(wide, 1569, 10), /超出了最近一张截图的范围（1568×441）/);
  assert.throws(() => toPhysical(wide, -1, 10), /超出/);
  assert.throws(() => toPhysical(null, 10, 10), /先 screenshot/);
  assert.throws(() => toPhysical(wide, 'a', 10), /需要 x 和 y/);
});

test('屏幕绝对坐标 → 截图像素：只对屏幕帧换算，窗口帧（原点会动）不给', () => {
  const second = makeFrame({ ox: -1920, oy: 0, w: 1920, h: 1080, fw: 1456, fh: 819 });
  assert.deepEqual(toFramePixels(second, -1920 + 960, 540), { x: 728, y: 410 });
  assert.equal(toFramePixels(second, 10, 10), null);
  const win = makeFrame({ ox: 400, oy: 300, w: 640, h: 420, fw: 640, fh: 420 }, { window: 123 });
  assert.equal(toFramePixels(win, 500, 400), null);
});

test('组合键解析：字母数字直接给键码（Ctrl+S 不会被补成 Ctrl+Shift+S），符号按布局查', () => {
  assert.deepEqual(parseKeys('Ctrl+S'), { mods: [0x11], key: 0x53, char: null });
  assert.deepEqual(parseKeys('ctrl+shift+end'), { mods: [0x11, 0x10], key: 0x23, char: null });
  assert.deepEqual(parseKeys('Alt+F4'), { mods: [0x12], key: 0x73, char: null });
  assert.deepEqual(parseKeys('Win+R'), { mods: [0x5B], key: 0x52, char: null });
  assert.deepEqual(parseKeys('Enter'), { mods: [], key: 0x0D, char: null });
  assert.deepEqual(parseKeys('Win'), { mods: [], key: 0x5B, char: null });
  assert.deepEqual(parseKeys('Ctrl++'), { mods: [0x11], key: null, char: '+' });
  assert.deepEqual(parseKeys('Ctrl+/'), { mods: [0x11], key: null, char: '/' });
  assert.throws(() => parseKeys('Ctrl+Shift'), /需要一个主键/);
  assert.throws(() => parseKeys('Ctrl+Banana'), /不认识的按键/);
  assert.throws(() => parseKeys('A+B'), /两个主键/);
});

test('结果排版：截图说明坐标就用这张图；老客户端的原图另作说明；点击回报落点', () => {
  assert.match(shotText({ fw: 1568, fh: 441, w: 5120, h: 1440 }), /截图 1568×441.*直接用这张图里的像素/);
  assert.match(shotText({ w: 5120, h: 1440, ox: 0, oy: 0 }), /旧版客户端/);
  const [t] = desktopContent('click', { ok: true, action: 'click', at: [10, 20], landed: '「记事本」(notepad)的 Button「保存」' });
  assert.equal(t.text, '已点击 (10, 20)：落在 「记事本」(notepad)的 Button「保存」');
  const b = desktopContent('batch', {
    ok: false, completed: 1, total: 3,
    steps: [{ step: 1, action: 'type', chars: 3 }, { step: 2, action: 'click', error: '超出范围' }],
    images: [],
  });
  assert.match(b[0].text, /1\/3 步完成（遇错停止）/);
  assert.match(b[0].text, /第 2 步 click 失败：超出范围/);
});

test('结果确认参数：默认开、verify:false 关、expect 拆成宿主核对项 + changed', async () => {
  const { obsParams } = await import('./remote-control-desktop.mjs');
  assert.equal(obsParams('click', {}).obs.on, true);
  assert.equal(obsParams('click', { verify: false }).obs, null);
  assert.equal(obsParams('move', {}).obs, null);
  assert.equal(obsParams('screenshot', {}).obs, null);
  const p = obsParams('click', { expect: { window: '另存为', changed: true, bogus: 'x' }, expect_timeout_ms: 5000 });
  assert.deepEqual(p.obs.expect, { window: '另存为' });
  assert.equal(p.wantChanged, true);
  assert.equal(p.obs.maxMs, 5000);
  assert.equal(obsParams('key', {}).obs.noChangeMs, 400);
});

test('结果确认归纳：窗口开关、控件状态、回读、密码框、changed 预期', async () => {
  const { buildVerify, BANNER_TITLE } = await import('./remote-control-desktop.mjs');
  const base = { settledMs: 300, stable: true, pixels: false, opened: [], closed: [], fgChanged: false };
  // 什么都没变
  assert.equal(buildVerify('click', { ...base, focusBefore: null, focusAfter: null }).changed, false);
  // 急停横幅第一次出现不算「打开了窗口」
  const v0 = buildVerify('click', { ...base, opened: [{ hwnd: 1, title: BANNER_TITLE }] });
  assert.equal(v0.changed, false);
  // 勾选框
  const v1 = buildVerify('click', { ...base, pixels: true, hasControl: true,
    controlBefore: { type: 'CheckBox', name: 'Agree', toggle: 'Off', enabled: true },
    controlAfter: { type: 'CheckBox', name: 'Agree', toggle: 'On', enabled: true } });
  assert.deepEqual(v1.control.changes, [{ key: 'toggle', from: 'Off', to: 'On' }]);
  // 打字回读：命中 / 没命中 / 回车后被清空 / 密码框
  const typed = (value, extra = {}) => buildVerify('type', { ...base, pixels: true, focusBefore: { type: 'Edit', value: '' }, focusAfter: { type: 'Edit', value, ...extra } }, { typed: '你好abc' });
  assert.equal(typed('前缀你好abc').readback.ok, true);
  assert.equal(typed('别的').readback.ok, false);
  assert.equal(typed(undefined, { password: true }).readback.password, true);
  const enter = buildVerify('type', { ...base, focusBefore: { type: 'Edit', value: '' }, focusAfter: { type: 'Edit', value: '' } }, { typed: 'hello\n' });
  assert.equal(enter.readback.ok, false);
  assert.equal(enter.readback.enter, true);
  // changed 预期在 node 侧核对
  const v2 = buildVerify('click', { ...base }, { wantChanged: true });
  assert.equal(v2.expect.ok, false);
  const v3 = buildVerify('click', { ...base, pixels: true, expect: { ok: true, checks: [{ key: 'window', want: 'x', ok: true, got: 'x' }] } }, { wantChanged: true });
  assert.equal(v3.expect.ok, true);
  assert.equal(v3.expect.checks.length, 2);
});

test('结果确认排版：没变化给提示、密码框不露内容、预期不符标 isError', async () => {
  const { verifyText, desktopResult } = await import('../mcp/desktop-format.mjs');
  assert.match(verifyText({ changed: false, settledMs: 800, stable: true }, 'click'), /^注意：画面、窗口、焦点和被点控件的状态都没有变化/);
  assert.match(verifyText({ changed: false, settledMs: 400, stable: true }, 'key'), /复制这类快捷键本来就不改画面/);
  assert.match(verifyText({ changed: true, settledMs: 300, stable: true, opened: [{ title: '另存为', process: 'notepad' }] }, 'click'), /打开了窗口「另存为」\(notepad\)（300ms 后界面稳定）/);
  assert.match(verifyText({ changed: true, settledMs: 300, stable: true, readback: { password: true } }, 'type'), /回读：密码框，不读内容/);
  assert.match(verifyText({ changed: true, settledMs: 300, stable: true, control: { type: 'CheckBox', name: 'Agree', changes: [{ key: 'toggle', from: 'Off', to: 'On' }] } }, 'click'), /CheckBox「Agree」的勾选：否 → 是/);
  const r = { ok: true, action: 'click', at: [1, 2], landed: 'x', verify: { changed: true, settledMs: 3000, stable: true, expect: { ok: false, checks: [{ key: 'window', want: '另存为', ok: false, got: '' }] } } };
  const out = desktopResult('click', r);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /预期不符合：有窗口含「另存为」——不符合/);
  assert.equal(desktopResult('click', { ...r, verify: { changed: true, settledMs: 300, stable: true } }).isError, undefined);
});

test('宿主指令的保留字段不能与指针坐标重名（emitEvents 曾叫 fx，把帧内横坐标盖成 0）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./remote-control-desktop.mjs', import.meta.url), 'utf8');
  const m = src.match(/JSON\.stringify\(\{ id, op, \.\.\.args, (\w+): Boolean\(observer\) \}\)/);
  assert.ok(m, 'sendCmd 追加的事件开关字段没找到');
  assert.ok(!['fx', 'fy', 'ox', 'oy', 'win', 'ew', 'eh', 'ref', 'kind', 'button', 'count', 'amount', 'guard', 'banner', 'bannerRect', 'obs'].includes(m[1]),
    `事件开关字段「${m[1]}」与指针指令字段重名`);
});

test('结果确认参数：launch 等得久；只有 type/key 带 window 时才让宿主先认准窗口；focus_window 只在带 expect 时确认', async () => {
  const { obsParams } = await import('./remote-control-desktop.mjs');
  const l = obsParams('launch', {}).obs;
  assert.equal(l.maxMs, 5000);
  assert.equal(l.noChangeMs, 2500);
  assert.equal(obsParams('launch', { expect: { window: '记事本' } }).obs.maxMs, 5000);
  assert.equal(obsParams('click', { expect: { window: '另存为' } }).obs.maxMs, 3000);
  assert.equal(obsParams('type', { text: 'x', window: 7 }).obs.target, 7);
  assert.equal(obsParams('key', { keys: 'Ctrl+S', window: '7' }).obs.target, 7);
  assert.equal(obsParams('type', { text: 'x', window: 0 }).obs.target, undefined);
  assert.equal(obsParams('type', { text: 'x' }).obs.target, undefined);
  assert.equal(obsParams('click', { x: 1, y: 1, window: 7 }).obs.target, undefined);
  assert.equal(obsParams('focus_window', { window: 7 }).obs, null);
  assert.deepEqual(obsParams('focus_window', { window: 7, expect: { focus: '搜索' } }).obs.expect, { focus: '搜索' });
  assert.equal(obsParams('focus_window', { window: 7, expect: { changed: true } }).wantChanged, true);
});

test('launch 的参数数组拼成 Windows 命令行：空白与引号加引号，引号前和结尾的反斜杠加倍', async () => {
  const { winArg, winArgs } = await import('./remote-control-desktop.mjs');
  assert.equal(winArg('notepad'), 'notepad');
  assert.equal(winArg('C:\\Program Files\\a.txt'), '"C:\\Program Files\\a.txt"');
  assert.equal(winArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(winArg('a\\"b'), '"a\\\\\\"b"');
  assert.equal(winArg('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(winArg('C:\\dir\\'), 'C:\\dir\\', '不加引号时结尾反斜杠原样保留');
  assert.equal(winArg(''), '""');
  assert.equal(winArgs(['/n', 'a b']), '/n "a b"');
  assert.equal(winArgs('x'), 'x');
  assert.equal(winArgs(null), '');
});

test('打字回读：每一段都要在；分得清没打进去、丢字乱序、打到了别处、回车提交、读不全', async () => {
  const { readback } = await import('./remote-control-desktop.mjs');
  const before = { type: 'Edit', name: '正文', value: 'old' };
  const el = (value, extra = {}) => ({ type: 'Edit', name: '正文', value, ...extra });
  assert.equal(readback('abc', el('oldabc'), before).kind, 'ok');
  assert.equal(readback('a  b', el('a b')).ok, true, '空白不计较');
  assert.equal(readback('1. 第一项', el('第一项')).ok, true, 'Word 自动编号吃掉的序号不计较');
  const un = readback('abc', el('old'), before);
  assert.equal(un.ok, false);
  assert.equal(un.kind, 'unchanged');
  assert.equal(readback('hello world', el('oldhelo world'), before).kind, 'mismatch', '丢字');
  assert.equal(readback('line1\nline2', el('line1\nlin2'), before).kind, 'mismatch', '前一段在、最后一段不对');
  assert.equal(readback('abc', el('zzz', { name: '别的框' }), before).kind, 'elsewhere', '焦点换了控件、一段都对不上');
  const committed = readback('hello\n', el(''), el('x'));
  assert.equal(committed.kind, 'committed');
  assert.equal(committed.enter, true);
  const cut = readback('tail', el('x'.repeat(4000)), before);
  assert.equal(cut.ok, null);
  assert.equal(cut.truncated, true);
  // 单行框回车把前一行提交走了；表单里 Tab 跳到下一个框——最后一段完整在就算对
  assert.equal(readback('first\nsecond', el('second'), before).kind, 'ok');
  assert.equal(readback('John\tSmith', { type: 'Edit', name: 'Last', value: 'Smith' }, { type: 'Edit', name: 'First', value: '' }).kind, 'ok');
  assert.equal(readback('   ', el('x')), null);
  assert.deepEqual(readback('abc', el('x', { password: true })), { password: true });
  assert.equal(readback('abc', { gone: true }).ok, null);
  assert.equal(readback('hello world. it works', el('Hello world. It works'), before).kind, 'ok', 'Word 句首自动大写不算丢字（否则 batch 会被误停）');
});

test('batch 停不停：预期不符、回读对不上、字没打进去才停；打到别处、回车提交、读不全不停', async () => {
  const { batchStop } = await import('./remote-control-desktop.mjs');
  const rb = (readback) => ({ ok: true, verify: { changed: true, readback } });
  assert.match(batchStop('type', rb({ ok: false, kind: 'mismatch' })), /对不上/);
  assert.match(batchStop('type', rb({ ok: false, kind: 'unchanged' })), /没打进去/);
  assert.equal(batchStop('type', rb({ ok: false, kind: 'elsewhere' })), null);
  assert.equal(batchStop('type', rb({ ok: false, kind: 'committed' })), null);
  assert.equal(batchStop('type', rb({ ok: null, truncated: true })), null);
  assert.equal(batchStop('type', rb({ ok: true, kind: 'ok' })), null);
  assert.equal(batchStop('key', rb({ ok: false, kind: 'mismatch' })), null);
  assert.match(batchStop('click', { ok: true, verify: { expect: { ok: false, checks: [] } } }), /预期不符/);
  assert.equal(batchStop('click', { ok: true }), null);
});

test('动作行：按键发往哪个窗口、之后前台换了也说；launch 报 pid / 协议激活；老客户端照排', async () => {
  const { actLine, desktopResult } = await import('../mcp/desktop-format.mjs');
  const np = { hwnd: 7, title: '记事本', process: 'notepad' };
  assert.equal(actLine({ action: 'type', chars: 3, sentTo: np, foreground: np }), '已输入 3 个字符，按键发往：「记事本」(notepad)');
  assert.equal(actLine({ action: 'key', keys: 'Ctrl+S', sentTo: np, foreground: { hwnd: 9, title: '另存为', process: 'notepad' } }),
    '已按 Ctrl+S，按键发往：「记事本」(notepad)，之后前台变成「另存为」(notepad)');
  assert.equal(actLine({ action: 'type', chars: 3, foreground: { title: '记事本' } }), '已输入 3 个字符（前台：「记事本」）');
  assert.equal(actLine({ action: 'type', chars: 3 }), '已输入 3 个字符');
  assert.equal(actLine({ action: 'launch', file: 'notepad.exe', pid: 12, verify: { changed: true } }), '已启动 notepad.exe（pid 12）');
  assert.match(actLine({ action: 'launch', file: 'ms-settings:', pid: null, activated: true }), /协议激活或交给了已在运行的程序/);
  assert.equal(actLine({ action: 'launch', file: 'x.exe', pid: 1, foreground: { title: 'X', process: 'x' } }), '已启动 x.exe（pid 1），前台：「X」(x)');
  assert.equal(desktopResult('launch', { ok: true, pid: 42, file: 'old.exe' }).content[0].text, '已启动 old.exe（pid 42）');
});

test('结果确认排版：launch / focus_window 没变化的提示；命中的窗口报进程名；别的程序的旧窗口不算数；回读各种情况', async () => {
  const { verifyText } = await import('../mcp/desktop-format.mjs');
  const ok = { changed: true, settledMs: 300, stable: true };
  assert.match(verifyText({ changed: false, settledMs: 2500, stable: true }, 'launch'), /^注意：启动后没有出现新窗口/);
  assert.match(verifyText({ changed: false, settledMs: 800, stable: true }, 'focus_window'), /本来就在前台/);
  const ex = (checks) => verifyText({ ...ok, expect: { ok: checks.every((c) => c.ok), checks } }, 'type');
  assert.match(ex([{ key: 'window', want: '记事本', ok: true, got: '无标题 - 记事本', proc: 'notepad' }]), /有窗口含「记事本」——符合（「无标题 - 记事本」\(notepad\)）/);
  assert.match(ex([{ key: 'window', want: '另存为', ok: true, got: '另存为', proc: 'explorer', other: true }]), /是这次新开的别的程序窗口/);
  assert.match(ex([{ key: 'window', want: '记事本', ok: false, got: '记事本', proc: 'notepad', stale: true }]), /不符合（只找到动作前就开着的别的程序窗口「记事本」\(notepad\)，不算数/);
  assert.match(ex([{ key: 'gone', want: '另存为', ok: false, got: '另存为', proc: 'notepad' }]), /窗口消失「另存为」——不符合（还在：「另存为」\(notepad\)）/);
  // 老客户端的命中项没有 proc：只报标题
  assert.match(ex([{ key: 'window', want: '记事本', ok: true, got: '记事本' }]), /符合（「记事本」）$/);
  const rb = (readback) => verifyText({ ...ok, readback }, 'type');
  assert.match(rb({ ok: false, kind: 'mismatch', value: 'helo' }), /回读：内容和输入不一致（现在是「helo」），可能丢字或乱序/);
  assert.match(rb({ ok: false, kind: 'unchanged', value: 'old' }), /字没打进去/);
  assert.match(rb({ ok: false, kind: 'committed', value: '', enter: true }), /回车可能已经把内容提交\/清空了/);
  assert.match(rb({ ok: false, kind: 'elsewhere', value: 'zzz' }), /焦点控件里没有刚输入的文字（现在是「zzz」）——字可能打到了别处$/);
  assert.match(rb({ ok: false, value: '', enter: true }), /或回车已经把内容提交\/清空了/, '老客户端没有 kind');
  assert.match(rb({ ok: null, truncated: true }), /内容太长，只读到前一段/);
  assert.match(rb({ ok: null }), /读不到焦点控件的内容/);
});

test('服务端等设备多久：长文本按字数放宽且比执行层自己的超时长；launch 至少 50s；batch 加上其中打字的字数', async () => {
  const { desktopWaitMs } = await import('../mcp/desktop-format.mjs');
  const { typeTimeoutMs } = await import('./remote-control-desktop.mjs');
  const long = 'x'.repeat(2000);
  assert.equal(desktopWaitMs('type', { text: long }, 20_000), 2000 * 52 + 30_000);
  assert.ok(desktopWaitMs('type', { text: long }, 20_000) > typeTimeoutMs(long));
  assert.equal(desktopWaitMs('type', { text: 'hi' }, 20_000), 30_104);
  assert.equal(desktopWaitMs('launch', {}, 20_000), 50_000);
  assert.equal(desktopWaitMs('launch', {}, 60_000), 60_000);
  assert.equal(desktopWaitMs('batch', { actions: [{ action: 'type', text: 'a\nb' }, { action: 'click' }] }, 120_000), 120_000 + 3 * 52 + 60);
  assert.equal(desktopWaitMs('batch', {}, 120_000), 120_000);
  assert.equal(desktopWaitMs('click', {}, 20_000), 20_000);
});

test('覆盖层键帽文字', async () => {
  const { keyLabels } = await import('./remote-control-desktop.mjs');
  assert.deepEqual(keyLabels('ctrl+shift+s'), ['Ctrl', 'Shift', 'S']);
  assert.deepEqual(keyLabels('Ctrl++'), ['Ctrl', '+']);
  assert.deepEqual(keyLabels('alt+f4'), ['Alt', 'F4']);
  assert.deepEqual(keyLabels('Escape'), ['Esc']);
});
