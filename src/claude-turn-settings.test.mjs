// 设置 → 每轮启动参数（runtime/claude-turn-settings.mjs）、提问超时（questions.mjs）、会话级输出风格（chat-prefs.mjs）。
// 数据根指到临时目录；不起 CLI，只验参数翻译。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-turnset-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const S = await import('./runtime/claude-settings.mjs');
const T = await import('./runtime/claude-turn-settings.mjs');
const Q = await import('./runtime/questions.mjs');
const P = await import('./runtime/chat-prefs.mjs');
const B = await import('./runtime/bus.mjs');

const admin = { kind: 'admin', key: 'admin', dataDir: path.join(tmp, 'admin'), shell: true };
const user = { kind: 'user', key: 'u:dora', dataDir: path.join(tmp, 'dora'), shell: false, sandbox: true };
const snap = { kind: 'snap', key: 'c:x', dataDir: path.join(tmp, 'snap'), shell: false, sandbox: true, snap: { token: 'x' } };

test('全默认：暂停二选一、动态工作流开、不写风格 / 语言 / 署名；老客户端请求体的建议与压缩点照用', () => {
  const r = T.turnSettings(admin, { suggest: true, compactFrac: 0.5 });
  assert.equal(r.pauseOnFlag, true);
  assert.deepEqual(r.sdk, { enableWorkflows: true, switchModelsOnFlag: false });
  assert.equal(r.suggest, true);
  assert.equal(r.compactFrac, 0.5);
  assert.equal(r.autoContinue, true);
  // 没带 suggest 的请求（老 apk 本机关掉了）照旧不建议
  assert.equal(T.turnSettings(admin, {}).suggest, false);
});

test('快照访客：一律老行为（自动切换、不建议、不下发偏好）', () => {
  const r = T.turnSettings(snap, { suggest: true, compactFrac: 0.4 });
  assert.equal(r.pauseOnFlag, false);
  assert.deepEqual(r.sdk, {});
  assert.equal(r.suggest, false);
  assert.equal(r.compactFrac, undefined);
});

test('无 shell 的注册用户：不写 enableWorkflows', () => {
  const r = T.turnSettings(user, {});
  assert.equal('enableWorkflows' in r.sdk, false);
  assert.equal(r.sdk.switchModelsOnFlag, false);
});

test('设置值翻成 flag 层：风格 / 语言 / 署名 / 工作流 / 安全栅门；服务端改过的建议与压缩点盖过请求体', () => {
  S.setClaudeSettings(admin, {
    outputStyle: 'Concise', replyLanguage: 'zh', attribution: 'none', enableWorkflows: false,
    switchModelsOnFlag: true, promptSuggestions: false, compactFrac: 0.6, autoContinueOnLimit: false,
  });
  const r = T.turnSettings(admin, { suggest: true, compactFrac: 0.3 });
  assert.equal(r.pauseOnFlag, false);
  // 开着也必须显式写 true：不写的话 CLI 回落读 ~/.claude/settings.json（维护者本机写着 false），会把回退模型压掉
  assert.equal(r.sdk.switchModelsOnFlag, true, '自动切换时 flag 层显式 true，盖过 user / project 层的 false');
  assert.equal(r.sdk.outputStyle, 'Concise');
  assert.equal(r.sdk.language, 'Simplified Chinese');
  assert.deepEqual(r.sdk.attribution, { commit: '', pr: '', sessionUrl: false });
  assert.equal(r.sdk.enableWorkflows, false);
  assert.equal(r.suggest, false);
  assert.equal(r.compactFrac, 0.6);
  assert.equal(r.autoContinue, false);
  S.setClaudeSettings(admin, { outputStyle: null, replyLanguage: 'en', attribution: null, enableWorkflows: null, switchModelsOnFlag: null, promptSuggestions: null, compactFrac: null, autoContinueOnLimit: null });
  assert.equal(T.turnSettings(admin, {}).sdk.language, 'English');
  S.setClaudeSettings(admin, { replyLanguage: null });
});

test('会话级输出风格：会话覆盖优先（含「默认」盖过全局），请求随带的新会话风格再优先', () => {
  S.setClaudeSettings(admin, { outputStyle: 'Explanatory' });
  P.setChatPrefsOutputStyle(admin, 'sess-0001', 'default');
  assert.equal(T.turnSettings(admin, { sessionId: 'sess-0001' }).sdk.outputStyle, 'default');
  assert.equal(T.turnSettings(admin, { sessionId: 'sess-0002' }).sdk.outputStyle, 'Explanatory');
  assert.equal(T.turnSettings(admin, { sessionId: null, outputStyle: 'Learning' }).sdk.outputStyle, 'Learning');
  // 发消息时 recordChatPrefs 不带风格 → 保留覆盖；带了 → 换掉；last 不沾会话覆盖
  P.recordChatPrefs(admin, 'sess-0001', { model: 'claude-opus-5-5', effort: null, fast: false });
  assert.equal(P.chatPrefsFor(admin, 'sess-0001').outputStyle, 'default');
  P.recordChatPrefs(admin, 'sess-0003', { model: null, effort: null, fast: false, outputStyle: 'Proactive' });
  assert.equal(P.chatPrefsFor(admin, 'sess-0003').outputStyle, 'Proactive');
  assert.equal(P.lastChatPrefs(admin).outputStyle, undefined);
  P.setChatPrefsOutputStyle(admin, 'sess-0001', null);
  assert.equal(P.chatPrefsFor(admin, 'sess-0001').outputStyle, undefined);
  S.setClaudeSettings(admin, { outputStyle: null });
});

test('会话级风格校验：只认可选清单里的（不分大小写），null 清掉', () => {
  assert.deepEqual(T.validSessionOutputStyle(admin, null), { ok: true, value: null });
  assert.deepEqual(T.validSessionOutputStyle(admin, 'concise'), { ok: true, value: 'Concise' });
  assert.equal(T.validSessionOutputStyle(admin, 'Nope').ok, false);
  assert.equal(T.validSessionOutputStyle(admin, '../x').ok, false);
  S.noteOutputStyles(admin, ['default', 'Concise', 'my-style']);
  assert.equal(T.validSessionOutputStyle(admin, 'my-style').value, 'my-style');
});

test('提问超时按设置：默认 10 分钟、never = 不超时', async () => {
  assert.equal(Q.questionTimeoutMs(admin), 600_000);
  S.setClaudeSettings(admin, { questionTimeout: 'never' });
  assert.equal(Q.questionTimeoutMs(admin), 0);
  S.setClaudeSettings(admin, { questionTimeout: '30m' });
  assert.equal(Q.questionTimeoutMs(admin), 1_800_000);
  S.setClaudeSettings(admin, { questionTimeout: null });
  // 0 = 不起计时器：手动 settle 才结束
  const p = Q.waitForAnswer('q-never', null, 0, 'admin');
  assert.ok(Q.pendingQuestions.has('q-never'));
  Q.pendingQuestions.get('q-never').settle({ answers: [] });
  assert.deepEqual(await p, { answers: [] });
  // 正常超时照旧
  await assert.rejects(Q.waitForAnswer('q-fast', null, 10, 'admin'), /timeout/);
});

test('输出风格清单：init 后按身份问一次 initializationResult，10 分钟内不重复', async () => {
  T._resetTurnSettings();
  let calls = 0;
  const q = { initializationResult: async () => { calls++; return { available_output_styles: ['default', 'Concise', 'Team voice'] }; } };
  T.refreshOutputStyles(user, q);
  T.refreshOutputStyles(user, q);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1);
  assert.ok(S.outputStylesFor(user).includes('Team voice'));
  T.refreshOutputStyles(snap, q);
  assert.equal(calls, 1, '快照访客不问');
});

test('限额续跑默认：撞墙处现读设置（停放复用的闭包里改了也生效）；快照访客一律不续', () => {
  assert.equal(T.autoContinueDefault(admin), true);
  S.setClaudeSettings(admin, { autoContinueOnLimit: false });
  assert.equal(T.autoContinueDefault(admin), false);
  S.setClaudeSettings(admin, { autoContinueOnLimit: null });
  assert.equal(T.autoContinueDefault(admin), true);
  assert.equal(T.autoContinueDefault(snap), false);
  assert.equal(T.autoContinueDefault(null), false);
});

test('输出风格清单有变化才推 claude.settings 快照（已连着的前端立刻列得出自定义风格）', async () => {
  T._resetTurnSettings();
  const got = [];
  const res = { writableEnded: false, write(s) { got.push(JSON.parse(String(s).replace(/^data: /, ''))); }, end() {}, on() {} };
  const off = B.busSubscribe(admin.key, res);
  try {
    const q = (list) => ({ initializationResult: async () => ({ available_output_styles: list }) });
    T.refreshOutputStyles(admin, q(['default', 'Concise', 'Team voice', 'Second']));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'claude.settings');
    assert.ok(got[0].settings.outputStyles.includes('Second'));
    // 同一份清单再学一次（10 分钟节流之外）：没变化不推
    T._resetTurnSettings();
    T.refreshOutputStyles(admin, q(['default', 'Concise', 'Team voice', 'Second']));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(got.length, 1);
  } finally { off(); }
});

test('子 agent 调度偏好：随设置存取、超长拒收；工作流关着不提示；第三方清单只在自定义 API 会话里当真能派', () => {
  S.setClaudeSettings(admin, { subagentDispatch: '  简单任务用 mimo-v2.6-flash  ' });
  assert.equal(T.turnSettings(admin, {}).dispatch, '简单任务用 mimo-v2.6-flash');
  assert.equal(T.turnSettings(user, {}).dispatch, '');                       // 没有命令行的身份：工作流本就不开
  assert.throws(() => S.setClaudeSettings(admin, { subagentDispatch: 'x'.repeat(2001) }));
  const catalog = [{ name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', contextWindow: 262144, vision: false, efforts: ['low', 'high'] }];
  assert.equal(T.dispatchNudge({ on: false, text: 'x', catalog }), '');
  const cus = T.dispatchNudge({ on: true, text: '简单任务用 mimo', custom: { main: 'big', small: 'tiny' }, catalog });
  assert.match(cus, /effort/);
  assert.match(cus, /- mimo-v2\.6-flash — MiMo（小米，上下文 262K，档位 low\/high）/);
  assert.match(cus, /以这里为准\]\n简单任务用 mimo$/);
  const off = T.dispatchNudge({ on: true, catalog });
  assert.doesNotMatch(off, /- mimo/);
  assert.match(off, /Claude 官方模型/);
  // 官方订阅会话经上游代理转发第三方（routed）：列出清单，说明只有工作流 agent() 能写第三方名
  const routed = T.dispatchNudge({ on: true, catalog, routed: true });
  assert.match(routed, /- mimo-v2\.6-flash — MiMo/);
  assert.match(routed, /Agent 工具的 model 只能填这几个别名/);
  assert.doesNotMatch(routed, /最接近的 Claude 别名/);
  S.setClaudeSettings(admin, { subagentDispatch: null });
});
