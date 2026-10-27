import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CdpSession } from './cdp.mjs';
import { viewerReport, profileDirFor } from './claude-browser.mjs';
import { DATA_ROOT } from './paths.mjs';
import { userRoot } from '../config/index.mjs';

// 面板可见性：agent 要用户动手前得知道用户看不看得到浏览器（对齐 Claude 桌面端 tabs_context 报面板显示 / 隐藏）。
test('viewerReport: nobody watching → tells the agent to ask the user to open the panel', async () => {
  const s = new CdpSession();
  const r = await viewerReport(s);
  assert.equal(r.visible, false);
  assert.match(r.text, /用户现在看不到这个浏览器/);
  assert.match(r.text, /Ctrl\+Shift\+B/);
});

test('viewerReport: phone / web panels are "open, foreground unknown"; leaving removes them', async () => {
  const s = new CdpSession();
  const off = s.addViewer({ kind: 'stream', where: '手机' });
  s.addViewer({ kind: 'stream', where: '网页端' });
  const r = await viewerReport(s);
  assert.equal(r.visible, null);
  assert.match(r.text, /手机开着浏览器面板；网页端开着浏览器面板（看不出是否在前台）/);
  off();
  assert.equal(s.viewers.size, 1);
});

test('viewerReport: desktop shell says whether the tab is actually on screen', async () => {
  const s = new CdpSession();
  s.desktopBroker = 'http://127.0.0.1:1/x';
  s.activeTargetId = 'T';
  s.addViewer({ kind: 'native', where: '桌面客户端' });
  s.shellViewState = async () => ({ ok: true, parent: 'main', mounted: true, windowShown: true, focused: false });
  let r = await viewerReport(s);
  assert.equal(r.visible, true);
  assert.match(r.text, /桌面客户端的浏览器面板正显示着这个页面（窗口不在前台）/);
  s.shellViewState = async () => ({ ok: true, parent: 'host', mounted: false, windowShown: false, focused: false });
  r = await viewerReport(s);
  assert.equal(r.visible, false, '卡片开着但视图停在屏幕外 = 看不到');
  assert.match(r.text, /不在屏幕上/);
  s.shellViewState = async () => null;   // 旧壳没有 view 接口
  r = await viewerReport(s);
  assert.match(r.text, /报不出它在不在屏幕上/);
});

test('viewerReport: snapshot guests count as watching', async () => {
  const s = new CdpSession();
  s.addViewer({ kind: 'guest' });
  const r = await viewerReport(s);
  assert.equal(r.visible, true);
  assert.match(r.text, /快照访客 1 人在看直播/);
});

// 持久配置档：主机身份与成员账号各有一份，临时身份没有。
test('profileDirFor: host and members persist, snapshot / share / odd ids stay ephemeral', () => {
  const saved = process.env.BRIDGE_BROWSER_PERSIST;
  try {
    delete process.env.BRIDGE_BROWSER_PERSIST;
    assert.equal(profileDirFor('admin'), path.join(DATA_ROOT, 'browser-profile'));
    assert.equal(profileDirFor('u:alice'), path.join(userRoot('alice'), '.bridge', 'browser-profile'), '成员的在他自己目录里，删号随目录走');
    assert.equal(profileDirFor('c:tok'), '', '快照访客一次性');
    assert.equal(profileDirFor('s:tok'), '', '分享链接一次性');
    assert.equal(profileDirFor('u:../evil'), '', '路径穿越的 id 不给');
    process.env.BRIDGE_BROWSER_PERSIST = '0';
    assert.equal(profileDirFor('admin'), '', '总开关');
  } finally {
    if (saved == null) delete process.env.BRIDGE_BROWSER_PERSIST; else process.env.BRIDGE_BROWSER_PERSIST = saved;
  }
});
