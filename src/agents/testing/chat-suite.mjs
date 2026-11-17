// runClaudeChat 特征测试的公共入口：隔离环境 → 起脚手架 → 逐个场景跑 → 与基准逐字比对（或重写基准）。
// 两个测试文件共用：claude-chat.test.mjs（插件系统没启动，功能开关恒开）、claude-chat-plugins.test.mjs（插件系统启动）。
//
// 本文件不能静态 import bridge 的运行时模块：环境变量要先于它们设好。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HEADER = '# runClaudeChat 特征测试基准。由特征测试生成，别手改；说明见 src/agents/claude-chat.test.mjs 文件头。\n';

function parseBaseline(text) {
  const out = new Map();
  let name = null, buf = [];
  const flush = () => { if (name !== null) out.set(name, buf.join('\n') + '\n'); };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m) { flush(); name = m[1]; buf = []; continue; }
    if (name !== null && line !== '') buf.push(line);
  }
  flush();
  return out;
}
const render = (sections) => HEADER + [...sections].map(([name, body]) => `\n## ${name}\n${body}`).join('');

/**
 * baseline：基准文件名前缀（testing/<baseline>.baseline.<平台>.txt）
 * scenarioFiles：场景模块（相对本目录），各导出 scenarios = [[名字, async (h) => …]]
 * setupFile：可选，导出 async setup({ dirs, harness }) → 可选的收尾函数；在场景之前跑（起插件系统之类）
 * env：追加 / 覆盖的环境变量
 */
export async function chatSuite({ baseline: baselineName, scenarioFiles, setupFile = '', env = {} }) {
  const UPDATE = process.env.UPDATE_CHAT_BASELINE === '1';
  const VERBOSE = process.env.CHAT_TEST_VERBOSE === '1';
  const ONLY = process.env.CHAT_TEST_ONLY || '';

  // ---- 隔离：数据根、工作空间、账号库、Claude 配置目录、家目录全指到一个临时目录 ----
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-chat-')));
  const dirs = {
    tmp,
    data: path.join(tmp, 'data'),
    vault: path.join(tmp, 'vault'),
    users: path.join(tmp, 'users'),
    claude: path.join(tmp, 'claude'),
    home: path.join(tmp, 'home'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // 从启动它的环境里继承来的开关与凭据一律清掉：基准不能随「在哪儿跑」变，凭据更不能进基准
  for (const k of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|_CLAUDE_|CLAUDE|BRIDGE_|VERTEX_|GEMINI_|OPENROUTER_|GIT_)/i.test(k) || ['PORT', 'VAULT_PATH', 'PYTHONIOENCODING', 'CODEX_BIN', 'PV_PUBLIC_DOMAIN'].includes(k)) delete process.env[k];
  }
  Object.assign(process.env, {
    BRIDGE_DATA_ROOT: dirs.data,
    VAULT_PATH: dirs.vault,
    BRIDGE_USERS_ROOT: dirs.users,
    CLAUDE_CONFIG_DIR: dirs.claude,
    USERPROFILE: dirs.home,
    HOME: dirs.home,
    APPDATA: path.join(dirs.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'),
    BRIDGE_MODULES_SKIP: 'all',
    BRIDGE_CLAUDE_IN_CHROME: '0',
    BRIDGE_NO_ROUTINES: '1',
    BRIDGE_DESKTOP_MIRROR: '0',
    BRIDGE_CLAUDE_CLI_DOWNLOAD: '0',
    BRIDGE_PLUGINS_STATE: path.join(dirs.data, 'plugins.json'),
    BRIDGE_PLUGINS_DIR: path.join(dirs.data, 'plugins'),
    // 手机文件 / 手机操控两个开关打开：手机 App 发起的轮与网页发起的轮各走一遍注入与反提示
    BRIDGE_PHONE_FS: '1',
    BRIDGE_PHONE_CONTROL: '1',
    // 探针：成员身份的 CLI 环境是白名单，这几个变量带没带过去记进 options 快照
    CHAR_PLAIN_CANARY: '1',
    CHAR_SECRET_TOKEN: 'canary',
    BRIDGE_CHAR_CANARY: '1',
    ...env,
  });

  const { makeChatHarness } = await import('./chat-harness.mjs');
  const scenarios = [];
  for (const f of scenarioFiles) scenarios.push(...(await import(f)).scenarios);

  const BASELINE = path.join(here, `${baselineName}.baseline.${process.platform}.txt`);
  const harness = makeChatHarness({ dirs, verbose: VERBOSE });
  const baseline = existsSync(BASELINE) ? parseBaseline(readFileSync(BASELINE, 'utf8')) : null;
  const produced = new Map();
  let teardown = null;

  if (setupFile) {
    test.before(async () => { teardown = await (await import(setupFile)).setup({ dirs, harness }); });
  }

  test.after(async () => {
    if (typeof teardown === 'function') { try { await teardown(); } catch {} }
    harness.shutdown();
    if (UPDATE && !ONLY) {
      const sections = new Map(produced);
      const table = (m, show) => [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sha, v]) => `${sha} ${show(v)}`).join('\n') + '\n';
      sections.set('options', table(harness.options, (json) => json));
      sections.set('texts', table(harness.texts, (t) => JSON.stringify(t)));
      writeFileSync(BASELINE, render(sections));
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    // runClaudeChat 留着几个不 unref 的兜底定时器（最长 10s）；结果都已输出，不等它们
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });

  for (const [name, fn] of scenarios) {
    if (ONLY && !name.includes(ONLY)) continue;
    // 上限给得宽：正常一个场景几十毫秒；这里只防「改坏了以后卡死」
    test(name, { timeout: 120_000 }, async (t) => {
      const text = await harness.run(name, fn);
      produced.set(name, text);
      if (VERBOSE) process.stdout.write(`\n## ${name}\n${text}`);
      if (UPDATE) return;
      if (!baseline) { t.skip(`没有 ${process.platform} 的基准（${path.basename(BASELINE)}）`); return; }
      assert.ok(baseline.has(name), `基准里没有这个场景：${name}（新加的场景要 UPDATE_CHAT_BASELINE=1 重写基准）`);
      assert.equal(text, baseline.get(name));
    });
  }

  test('基准里的场景一个不多一个不少', (t) => {
    if (UPDATE || ONLY) return;
    if (!baseline) { t.skip('没有当前平台的基准'); return; }
    assert.deepEqual([...baseline.keys()].filter((k) => k !== 'texts' && k !== 'options'), scenarios.map(([name]) => name));
  });
}
