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
const R = await import('./runtime/model-ratings.mjs');

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

// 子 agent 调用策略文件的形状（runtime/dispatch-policy.mjs）：总开关、三种范围、是否用非 Claude、一套生效的策略（判定线 / 档位自定义 / 口述备注）
const POL = (over = {}, st = {}) => ({
  v: 1, enabled: true, scope: { workflow: true, subagent: true, session: false }, allowThirdParty: true, activeId: 's-00000000',
  strategies: [{
    id: 's-00000000', name: '默认', floors: { top: null, hard: null, normal: null, light: null },
    overrides: { top: null, hard: null, normal: null, light: null }, note: '', ...st,
  }],
  rev: 0, ...over,
});
const SC = (workflow, subagent, session = false) => ({ workflow, subagent, session });

test('调度偏好并入调用策略：不再是设置项，turnSettings 不再带 dispatch', () => {
  assert.throws(() => S.setClaudeSettings(admin, { subagentDispatch: '简单任务用 mimo' }), /unknown setting/);
  for (const c of [admin, user, snap]) assert.equal('dispatch' in T.turnSettings(c, {}), false);
});

test('总开关与生效范围：关着不提示、subRoute 的前提（workflow 范围）跟着关、start_session 的 auto 一句只在 session 范围开且有会话工具时补', () => {
  const none = SC(false, false);
  assert.deepEqual(T.dispatchScopes(null, true), none);
  assert.deepEqual(T.dispatchScopes(POL({ enabled: false }), true), none);                  // 总开关关：claude.mjs 的 subRoute 要 .workflow，跟着为 null
  assert.deepEqual(T.dispatchScopes(POL(), true), SC(true, true));
  assert.deepEqual(T.dispatchScopes(POL(), false), SC(false, true));                        // 动态工作流没开：workflow 范围不算，普通子 agent 照管
  assert.deepEqual(T.dispatchScopes(POL({ scope: SC(true, false, true) }), true), SC(true, false, true));
  // start_session 的 auto:<档> 一句
  assert.equal(T.sessionAutoNudge(T.dispatchScopes(POL(), true), true), '');                // session 范围默认关
  const on = T.dispatchScopes(POL({ scope: SC(true, true, true) }), true);
  assert.equal(T.sessionAutoNudge(on, false), '');                                          // 没有会话工具（快照、项目协调者）
  assert.equal(T.sessionAutoNudge(on, true), '\n\n' + T.SESSION_AUTO_LINE);
  assert.match(T.SESSION_AUTO_LINE, /^start_session 的 model 可以写 auto:top \/ auto:hard \/ auto:normal \/ auto:light（最难 \/ 难 \/ 常规 \/ 机械）/);
  assert.equal(T.sessionAutoNudge(T.dispatchScopes(POL({ enabled: false, scope: SC(true, true, true) }), true), true), '');
  // dispatchNudge：总开关关 / 没有策略 / 两个范围都不生效 / on=false → 空
  const catalog = [{ name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', contextWindow: 262144, vision: false, efforts: ['low', 'high'] }];
  for (const ratings of [false, null]) {
    R._setRatingsForTests(ratings);
    try {
      assert.equal(T.dispatchNudge({ on: true, policy: POL({ enabled: false }, { note: 'x' }), workflowOn: true, catalog, routed: true }), '');
      assert.equal(T.dispatchNudge({ on: true, policy: null, workflowOn: true, catalog }), '');
      assert.equal(T.dispatchNudge({ on: true, policy: POL({ scope: SC(true, false, true) }), workflowOn: false, catalog }), '');
      assert.equal(T.dispatchNudge({ on: true, policy: POL({ scope: SC(false, false, true) }), workflowOn: true, catalog }), '');
      assert.equal(T.dispatchNudge({ on: false, policy: POL(), workflowOn: true, catalog }), '');
    } finally { R._setRatingsForTests(null); }
  }
});

test('没有性价比快照：老写法（分档 + 全清单），按范围裁剪；第三方清单只在自定义 API 会话里当真能派；备注走口述偏好', () => {
  const catalog = [{ name: 'mimo-v2.6-flash', label: 'MiMo', provider: '小米', contextWindow: 262144, vision: false, efforts: ['low', 'high'] }];
  R._setRatingsForTests(false);   // 没有性价比快照：老写法（分档 + 全清单）
  try {
    assert.equal(T.dispatchNudge({ on: false, policy: POL({}, { note: 'x' }), workflowOn: true, catalog }), '');
    const cus = T.dispatchNudge({ on: true, policy: POL({}, { note: '简单任务用 mimo' }), workflowOn: true, custom: { main: 'big', small: 'tiny' }, catalog });
    assert.match(cus, /effort/);
    assert.match(cus, /- mimo-v2\.6-flash — MiMo（小米，上下文 262K，档位 low\/high）/);
    assert.match(cus, /以这里为准\]\n简单任务用 mimo$/);
    const off = T.dispatchNudge({ on: true, policy: POL(), workflowOn: true, catalog });
    assert.doesNotMatch(off, /- mimo/);
    assert.match(off, /Claude 官方模型/);
    // 官方订阅会话经上游代理转发第三方（routed）：列出清单，说明只有工作流 agent() 能写第三方名
    const routed = T.dispatchNudge({ on: true, policy: POL(), workflowOn: true, catalog, routed: true });
    assert.match(routed, /- mimo-v2\.6-flash — MiMo/);
    assert.match(routed, /Agent 工具的 model 只能填这几个别名/);
    assert.doesNotMatch(routed, /最接近的 Claude 别名/);
    // 有清单就交代 id / 显示名的分工：对用户只说显示名（10-30 录屏里分工表写成 custom:p-xxxx:… 原始 id）
    for (const s of [cus, routed]) assert.match(s, /一律用显示名（如「MiMo」/);
    assert.doesNotMatch(off, /一律用显示名/);
    // 范围裁剪：只管工作流 → 只讲 agent()，不写「Agent 工具的 model 只能填别名」
    const wf = T.dispatchNudge({ on: true, policy: POL({ scope: SC(true, false) }), workflowOn: true, catalog, routed: true });
    assert.match(wf, /在动态工作流脚本里用 agent\(\) 派子 agent 时/);
    assert.match(wf, /Agent 工具派的子 agent 不在这条要求里/);
    assert.match(wf, /- mimo-v2\.6-flash — MiMo/);
    assert.doesNotMatch(wf, /Agent 工具的 model 只能填/);
    const wfCus = T.dispatchNudge({ on: true, policy: POL({ scope: SC(true, false) }), workflowOn: true, custom: { main: 'big', small: 'tiny' }, catalog });
    assert.doesNotMatch(wfCus, /Agent 工具的 model 只能填/);
    // 只管普通子 agent → 只讲 Agent 工具，不列第三方清单
    const sub = T.dispatchNudge({ on: true, policy: POL({ scope: SC(false, true) }), workflowOn: true, catalog });
    assert.match(sub, /用 Agent 工具派子 agent 时/);
    assert.match(sub, /动态工作流脚本里的 agent\(\) 不在这条要求里/);
    assert.doesNotMatch(sub, /- mimo|auto:/);
    assert.match(sub, /派不了（Agent 工具的 model 只认 Claude 别名）/);
    const subCus = T.dispatchNudge({ on: true, policy: POL({ scope: SC(false, true) }), workflowOn: true, custom: { main: 'big', small: 'tiny' }, catalog });
    assert.match(subCus, /Agent 工具的 model 只能填别名：haiku = tiny/);
    assert.doesNotMatch(subCus, /- mimo|agent\(prompt/);
    // 动态工作流没开：只剩普通子 agent，也不提工作流
    const noWf = T.dispatchNudge({ on: true, policy: POL(), workflowOn: false, catalog });
    assert.match(noWf, /用 Agent 工具派子 agent 时/);
    assert.doesNotMatch(noWf, /动态工作流/);
    // 不调用非 Claude 模型：官方会话不列第三方、明说用户关了；自定义 API 会话只留 Claude 型号（这里一个都没有）
    const noTp = T.dispatchNudge({ on: true, policy: POL({ allowThirdParty: false }), workflowOn: true, catalog, routed: true });
    assert.doesNotMatch(noTp, /- mimo/);
    assert.match(noTp, /用户设置了不调用非 Claude 模型/);
    const noTpCus = T.dispatchNudge({ on: true, policy: POL({ allowThirdParty: false }), workflowOn: true, custom: { main: 'big', small: 'tiny' }, catalog });
    assert.doesNotMatch(noTpCus, /- mimo/);
    assert.match(noTpCus, /不调用非 Claude 模型，配置里没有 Claude 型号可派/);
    const claudeCat = [...catalog, { name: 'custom:p-aaaaaa:claude-sonnet-5-5', label: 'Sonnet 中转', provider: '中转', contextWindow: 0, vision: true, efforts: [] }];
    const noTpCus2 = T.dispatchNudge({ on: true, policy: POL({ allowThirdParty: false }), workflowOn: true, custom: { main: 'big', small: 'tiny' }, catalog: claudeCat });
    assert.match(noTpCus2, /- custom:p-aaaaaa:claude-sonnet-5-5 — Sonnet 中转/);
    assert.doesNotMatch(noTpCus2, /- mimo/);
  } finally { R._setRatingsForTests(null); }   // 回到读真快照
});

test('有性价比快照：调度提示给四档阶梯（首选 + 备选、auto 写法），被胜出的与未评分的各一行', () => {
  R._setRatingsForTests({
    generated: '2026-10-30',
    models: [
      { slug: 'claude-opus-5-5', base: 'claude-opus-5-5', effort: 'max', ii: 58, cost: 67 },
      { slug: 'claude-opus-5-5-high', base: 'claude-opus-5-5', effort: 'high', ii: 52, cost: 23 },
      { slug: 'claude-haiku-5-5-medium', base: 'claude-haiku-5-5', effort: 'medium', ii: 25, cost: 0.6 },
      { slug: 'claude-sonnet-5-5-high', base: 'claude-sonnet-5-5', effort: 'high', ii: 41, cost: 11 },
      { slug: 'mimo-v2-6-flash', base: 'mimo-v2-6-flash', effort: '', ii: 27, cost: 0.86 },
    ],
    plans: { max20: { 'claude-opus-5-5': 1.4, 'claude-opus-5-5-high': 0.5, 'claude-haiku-5-5-medium': 0.01, 'claude-sonnet-5-5-high': 0.24 } },
  });
  try {
    const catalog = [
      { name: 'mimo-v2.6-flash', label: 'MiMo Flash', provider: '小米', contextWindow: 262144, vision: false, efforts: ['off', 'on'] },
      { name: 'odd-model', label: 'Odd', provider: 'X', contextWindow: 0, vision: true, efforts: [] },
    ];
    const base = { on: true, policy: POL(), workflowOn: true, catalog };
    const routed = T.dispatchNudge({ ...base, policy: POL({}, { note: '偏好原文' }), routed: true, plan: 'max20' });
    assert.match(routed, /2026-10-30 版/);
    assert.match(routed, /最难（[^）]+）→ auto:top = opus · max（Opus 5\.5，智力 58 · ¥1\.40 订阅等效）/);
    assert.match(routed, /难（[^）]+）→ auto:hard = opus · high/);
    // 机械档：订阅的 Haiku 最便宜；备选给不占订阅额度的第三方，带上下文与看图限制
    assert.match(routed, /机械（[^）]+）→ auto:light = haiku · medium（Haiku 5\.5，[^）]+）；备选 mimo-v2\.6-flash（MiMo Flash，智力 27 · ¥0\.86，上下文 262K，不看图）/);
    // 订阅里的模型都够不着的档，备选给不占额度里最强的一个并标「略弱」
    assert.match(routed, /auto:hard = opus · high（[^）]+）；备选 mimo-v2\.6-flash（[^）]+比这档略弱）/);
    assert.match(routed, /Agent 工具的 model 只能填别名：最难 opus \+ effort max，难 opus \+ effort high，常规 sonnet \+ effort high/);
    assert.match(routed, /未评分[^\n]*odd-model（Odd）/);
    assert.match(routed, /以这里为准\]\n偏好原文$/);
    assert.doesNotMatch(routed, /^  - /m);                              // 不再列全清单
    // 官方会话没挂上转发：只有 Claude 别名，不教 auto 写法
    const plain = T.dispatchNudge({ ...base, plan: 'max20' });
    assert.doesNotMatch(plain, /auto:/);
    assert.doesNotMatch(plain, /mimo-v2\.6-flash · /);
    assert.match(plain, /派不了/);
    // 自定义 API 会话：全是 API 价，Agent 工具只设 effort
    const cus = T.dispatchNudge({ ...base, custom: { main: 'big', small: 'tiny' } });
    assert.match(cus, /auto:light = mimo-v2\.6-flash（MiMo Flash，智力 27 · ¥0\.86/);
    assert.match(cus, /haiku = tiny，sonnet \/ opus = 主会话模型 big/);
    assert.doesNotMatch(cus, /订阅等效/);
    // 范围裁剪：只管工作流 → 阶梯照给、auto 照教，不写「Agent 工具的 model 只能填别名」
    const wf = T.dispatchNudge({ ...base, policy: POL({ scope: SC(true, false) }), routed: true, plan: 'max20' });
    assert.match(wf, /auto:hard = opus · high/);
    assert.match(wf, /备选 mimo-v2\.6-flash/);
    assert.doesNotMatch(wf, /Agent 工具的 model 只能填/);
    const wfCus = T.dispatchNudge({ ...base, policy: POL({ scope: SC(true, false) }), custom: { main: 'big', small: 'tiny' } });
    assert.match(wfCus, /auto:light = mimo-v2\.6-flash/);
    assert.doesNotMatch(wfCus, /Agent 工具的 model 只能填/);
    // 只管普通子 agent → 只给 Agent 工具那套（Claude 别名），不写 auto:<档>、不给备选
    const sub = T.dispatchNudge({ ...base, policy: POL({ scope: SC(false, true) }), routed: true, plan: 'max20' });
    assert.match(sub, /用 Agent 工具派子 agent 时/);
    assert.match(sub, /难（[^）]+）→ opus · high/);
    assert.doesNotMatch(sub, /auto:/);
    assert.doesNotMatch(sub, /备选/);
    assert.match(sub, /Agent 工具的 model 写括号前的别名/);
    // 判定线够不着 → 取最强的并标出；档位自定义 → 标「用户指定」（工作流阶梯与 Agent 工具那行都标）
    const tuned = T.dispatchNudge({
      ...base, routed: true, plan: 'max20',
      policy: POL({}, { floors: { top: 90, hard: null, normal: null, light: null }, overrides: { top: null, hard: null, normal: null, light: { model: 'sonnet', effort: 'high' } } }),
    });
    assert.match(tuned, /auto:top = opus · max（[^）]+）（没有模型够得着这条线，取最强的）/);
    assert.match(tuned, /auto:light = sonnet · high（[^）]+）（用户指定）/);
    assert.match(tuned, /机械 sonnet \+ effort high（用户指定）/);
    assert.doesNotMatch(tuned, /auto:hard = [^\n]*（用户指定）/);
    // 不调用非 Claude 模型：阶梯里没有第三方（不给备选），明说用户关了
    const noTp = T.dispatchNudge({ ...base, policy: POL({ allowThirdParty: false }), routed: true, plan: 'max20' });
    assert.match(noTp, /auto:light = haiku · medium/);
    assert.doesNotMatch(noTp, /mimo-v2\.6-flash/);
    assert.match(noTp, /用户设置了不调用非 Claude 模型/);
    assert.doesNotMatch(noTp, /odd-model/);
  } finally { R._setRatingsForTests(null); }
});

test('工作流 agent 的档位从子 agent 转录的 api-request 行补', async () => {
  const { annotateWorkflowEfforts } = await import('./runtime/tool-summary.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const sub = path.join(tmp, 'sess', 'subagents');
  mkdirSync(path.join(sub, 'workflows', 'wf_1'), { recursive: true });
  writeFileSync(path.join(sub, 'workflows', 'wf_1', 'agent-a1.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi "output_config":{"effort":"max"}' } }),
    JSON.stringify({ type: 'api-request', params: { model: 'custom:p-1:deepseek-v4-pro', output_config: { effort: 'medium' } } }),
  ].join('\n') + '\n');
  const out = annotateWorkflowEfforts([
    { type: 'workflow_phase', index: 0, title: 'Write' },
    { type: 'workflow_agent', index: 0, agentId: 'a1', model: 'custom:p-1:deepseek-v4-pro' },
    { type: 'workflow_agent', index: 1, agentId: 'gone', model: 'sonnet' },
    { type: 'workflow_agent', index: 2, agentId: '../x', model: 'sonnet' },
  ], sub);
  assert.equal(out[1].effort, 'medium');   // 用户正文里长得像的不算，只认 api-request 行
  assert.equal(out[2].effort, undefined);
  assert.equal(out[3].effort, undefined);
  assert.equal(annotateWorkflowEfforts(undefined, sub), undefined);
});

test('直播路径带缓存：读到的档位不再读盘，没读到的稍后重读', async () => {
  const { annotateWorkflowEfforts } = await import('./runtime/tool-summary.mjs');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const sub = path.join(tmp, 'sess-live', 'subagents');
  const wf = path.join(sub, 'workflows', 'wf_1');
  mkdirSync(wf, { recursive: true });
  const cache = new Map();
  const prog = [{ type: 'workflow_agent', index: 0, agentId: 'b1', model: 'fable' }];
  assert.equal(annotateWorkflowEfforts(prog, sub, null, cache)[0].effort, undefined);   // agent 还没发请求
  writeFileSync(path.join(wf, 'agent-b1.jsonl'), JSON.stringify({ type: 'api-request', params: { model: 'claude-fable-5-2', output_config: { effort: 'xhigh' } } }) + '\n');
  assert.equal(annotateWorkflowEfforts(prog, sub, null, cache)[0].effort, undefined);   // 刚落空过，这一帧不重读
  cache.get('e:b1').at = 0;
  assert.equal(annotateWorkflowEfforts(prog, sub, null, cache)[0].effort, 'xhigh');
  rmSync(wf, { recursive: true, force: true });
  assert.equal(annotateWorkflowEfforts(prog, sub, null, cache)[0].effort, 'xhigh');     // 命中后不再读盘
});

test('工作流 auto:<档> agent 补真实模型与档位（直播不读转录）', async () => {
  const { annotateWorkflowEfforts } = await import('./runtime/tool-summary.mjs');
  const asked = [];
  const out = annotateWorkflowEfforts([
    { type: 'workflow_agent', index: 0, agentId: 'a1', model: 'auto:hard', effort: 'medium' },
    { type: 'workflow_agent', index: 1, agentId: 'a2', model: 'auto:hard' },
    { type: 'workflow_agent', index: 2, agentId: 'a3', model: 'auto:light' },
    { type: 'workflow_agent', index: 3, agentId: 'a4', model: 'sonnet' },
  ], '', (name) => { asked.push(name); return name === 'auto:hard' ? { model: 'claude-opus-5-5', effort: 'high' } : null; });
  assert.deepEqual([out[0].servedModel, out[0].effort], ['claude-opus-5-5', 'high']);   // CLI 发的 medium 不作数
  assert.deepEqual([out[1].servedModel, out[1].effort], ['claude-opus-5-5', 'high']);
  assert.equal(out[2].servedModel, undefined);
  assert.equal(out[3].effort, undefined);
  assert.deepEqual(asked, ['auto:hard', 'auto:light']);   // 每档只算一次
});
