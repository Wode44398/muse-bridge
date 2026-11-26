// catalog.mjs：工具清单的体量估算、同族合并、按份额让出（纯函数，不起服务）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agyDeclUnits, mergeFamilies, expandFamilyCall, memberToolName, familyOfMember, fitBridgeShare, AGY_TOOL_FAMILIES,
} from './catalog.mjs';

const tool = (name, props = {}, description = name) => ({ name, description, inputSchema: { type: 'object', properties: props } });
// 体量约为 n 的假工具（说明用 ASCII 凑）
const sized = (name, n) => tool(name, {}, 'x'.repeat(Math.max(0, Math.round(((n - 110) / 1.31 - 12) * 4))));

test('体量估算按 11-24 那份 agy 记录标定：小工具约 190、固定开销约 110', () => {
  // ui_view 原样（agy 记的是 186）
  const uiView = { name: 'ui_view', description: '查看用户当前打开的 Bridge 客户端界面状态（所在分页、打开的文件面板路径、正在预览的文件、前台可见性与手机设备句柄）。', inputSchema: { properties: {}, type: 'object' } };
  const u = agyDeclUnits(uiView);
  assert.ok(u >= 170 && u <= 200, String(u));
  assert.ok(Math.abs(agyDeclUnits(sized('t', 2000)) - 2000) < 10);
});

test('同族合并：一个工具按 action 分派，参数取并集，原顺序位置不变；action 换回原工具名', () => {
  const tools = [
    tool('browser', { url: { type: 'string' } }),
    tool('pr_status'),
    tool('pr_bind', { url: { type: 'string', description: 'PR 链接' } }),
    tool('workspace'),
    tool('pr_set_auto_merge', { enabled: { type: 'boolean' }, url: { type: 'string' }, merge_method: { type: 'string', enum: ['squash'] } }),
  ];
  const out = mergeFamilies(tools);
  assert.deepEqual(out.map((t) => t.name), ['browser', 'pr', 'workspace']);
  const pr = out[1];
  assert.deepEqual(pr.inputSchema.properties.action.enum, ['status', 'bind', 'set_auto_merge']);   // 只列在场的成员
  assert.deepEqual(Object.keys(pr.inputSchema.properties), ['action', 'url', 'enabled', 'merge_method']);
  assert.equal(pr.inputSchema.properties.url.description, 'PR 链接');   // 同名参数取第一个成员的
  assert.deepEqual(pr.inputSchema.required, ['action']);
  assert.deepEqual(pr._members.map((m) => m.name), ['pr_status', 'pr_bind', 'pr_set_auto_merge']);

  assert.deepEqual(expandFamilyCall('pr', { action: 'set_auto_merge', enabled: true }), { family: AGY_TOOL_FAMILIES[0], member: 'pr_set_auto_merge', args: { enabled: true } });
  assert.equal(expandFamilyCall('pr', { action: 'nuke' }).member, '');
  assert.equal(expandFamilyCall('browser', { action: 'navigate' }), null);
  assert.equal(memberToolName('phone_files', { action: 'DELETE' }), 'phone_delete');
  assert.equal(memberToolName('phone_files', { action: 'pull' }), 'phone_files');   // 不认识的 action：按合并名判（偏保守）
  assert.equal(memberToolName('phone_control', { action: 'screen' }), 'phone_control');
  assert.equal(familyOfMember('project_memory_write')?.name, 'project_memory');
  assert.equal(familyOfMember('phone_control'), null, 'phone_control 不在手机文件那一族里');
});

test('份额：不超不动；超了按先后整组让出（拉取请求最先），浏览器 / 终端 / 电脑永远不让，成组的一起让', () => {
  const base = [
    sized('browser', 2200), sized('device_browser', 2300), sized('terminal', 700), sized('device_act', 1400),
    sized('pr', 460), sized('project_memory', 330), sized('media_music', 620), sized('media_speech', 520),
    sized('visualize_read_me', 430), sized('visualize_show_widget', 300), sized('plugin_android_android', 1130),
  ];
  const total = base.reduce((a, t) => a + agyDeclUnits(t), 0);
  assert.deepEqual(fitBridgeShare(base, total).withheld, []);
  assert.equal(fitBridgeShare(base, total).tools, base);

  // 超出约 400：只让出拉取请求
  assert.deepEqual(fitBridgeShare(base, total - 400).withheld, ['pr']);
  // 超出约 1000：拉取请求、项目记忆、音乐、配音依次让
  assert.deepEqual(fitBridgeShare(base, total - 1500).withheld, ['pr', 'project_memory', 'media_music', 'media_speech']);
  // 让到图表时一对一起让
  const deep = fitBridgeShare(base, total - 3200);
  assert.ok(deep.withheld.includes('plugin_android_android'));
  const vis = ['visualize_read_me', 'visualize_show_widget'].filter((n) => deep.withheld.includes(n));
  assert.ok(vis.length === 0 || vis.length === 2, `图表两样要么都在要么都让：${deep.withheld}`);
  // 份额再小，浏览器 / 终端 / 电脑也不让
  const floor = fitBridgeShare(base, 100);
  for (const n of ['browser', 'device_browser', 'terminal', 'device_act']) assert.ok(floor.tools.some((t) => t.name === n), n);
  assert.deepEqual(floor.tools.map((t) => t.name), ['browser', 'device_browser', 'terminal', 'device_act']);
});
