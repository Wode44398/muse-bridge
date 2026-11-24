// 新建插件骨架（agent 操作 plugins.scaffold、命令行 npm run plugin:new 共用）。放在 src/ 里，跟着安装包和 Docker 镜像走：
// 没有源码仓库的用户，bridge 里的 Claude 也能一步建好插件目录再登记。
//
// scaffoldPlugin({ id, dir, panel?, from?, template?, name?, description? }) → { dir, files }
//   from / template 都缺省（或 template: 'basic'）  生成最小骨架：bridge-plugin.json（一项示例配置）、index.mjs（接口 + Claude 工具 + agent 操作 + 状态块）、README.md；
//               panel:true 再带一个控制面板页面 web/index.html（用 /plugins/_sdk/bridge-plugin.js）。
//   from 填示例 把 src/plugins/examples/<示例>/ 整个拷过去，文本文件里的示例 id 换成新 id（下划线形式的 agent 操作组名一起换）。
//   template 填应用模板（TEMPLATES，与 from 互斥）：内联生成一个「应用」插件，应用 id 固定为 main、标题用 name（缺省用插件 id），
//               都带深浅两枚图标、locales/en.json、README。做完 → plugins.reload → 用 ui.open 的 app 参数（<插件 id>:main）带用户去看。
// 目标目录要么不存在、要么是空的；不覆盖任何已有文件。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReservedTitle } from './app-spec.mjs';

export const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'examples');
// 可以拿来当起点的示例（目录名 → 说明）
export const EXAMPLES = Object.freeze({
  'hello-world': '最小完整示例：一个接口、一个给 Claude 的工具、一个 agent 操作、自动生成的设置表单、一个插件页面',
  'hello-app': '插件应用的最小示例：纯页面插件（没有 index.mjs），清单 ui.apps 在主页加一个图标，点开是全屏分页（深浅两枚图标、成员也能用）',
  'qq-onebot': 'QQ 机器人（OneBot 11）：以授权账号跑 Claude（ctx.chat）、收外部推送（ctx.webhook）、托管外部程序（ctx.process）、分组表单 / 按群设置、状态块与动作按钮、控制面板',
  'power-tools': '改到核心：订阅事件、钩子拦命令、审批策略、消息改写、每轮参数、两个 agent 都能用的卡片工具、主页卡片、「/」命令、消息菜单、通知渠道',
  'hello-view': '声明式应用的示例：不写页面，index.mjs 里 ctx.ui.app 登记 view 与 actions，bridge 按积木画（统计、列表、表单、图表、标签页、按钮），数据存 ctx.store',
  'workspace-demo': '工作区插槽的示例：把文件夹标成 Antigravity 与 Claude 共用（ctx.ui.workspaceDecor 的全部字段）、文件夹菜单项带开关的确认框与撤销（workspaceAction）、refreshDecor、记忆目录、两个 agent 的轮次事件',
});
// 应用模板（与 EXAMPLES 分开：不是拷目录，而是按 id / 标题内联生成干净的起点；'basic' = 上面的最小骨架）
export const TEMPLATES = Object.freeze({
  'app-page': '页面应用：纯页面插件（没有 index.mjs），清单 ui.apps 在主页加一个图标，点开是你自己写的 web/app.html；界面要自己排版、要用浏览器能力（画布、拖放、媒体）时选它',
  'app-view': '声明式应用：不写页面，index.mjs 里 ctx.ui.app 登记 view（回积木列表）与 actions，bridge 自己画界面；数据存 ctx.store；记账、清单、表单、看板这类常规界面选它，最省事',
  'app-chat': '和 Claude 对话的应用：页面应用 + page.chat 权限，页面里一个对话区（bridge.chat.start / send / on / stop），会话记在 bridge.kv；要在自己的页面里和 Claude 来回对话时选它（只要一个对话框的，用声明式应用的 chat 积木也行）',
});
export const APP_TEMPLATE_IDS = Object.freeze(['basic', ...Object.keys(TEMPLATES)]);

const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const TEXT_EXT = new Set(['.json', '.mjs', '.js', '.cjs', '.html', '.css', '.md', '.txt']);

export class ScaffoldError extends Error {}

function listFiles(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p, base));
    else if (ent.isFile()) out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

export function scaffoldPlugin({ id, dir, panel = false, from = null, template = null, name = '', description = '' }) {
  if (!ID_RE.test(String(id || ''))) throw new ScaffoldError('id 不合法：小写字母开头，只用小写字母、数字、连字符（≤48 字），如 weather、my-notes');
  if (!dir || !path.isAbsolute(String(dir))) throw new ScaffoldError('dir 要写绝对路径');
  const tpl = template && template !== 'basic' ? String(template) : null;
  if (tpl && !Object.hasOwn(TEMPLATES, tpl)) throw new ScaffoldError('没有模板「' + tpl + '」（可用：' + APP_TEMPLATE_IDS.join(' / ') + '）');
  if (tpl && from) throw new ScaffoldError('template 和 from 只给一个：template 是内联生成的应用起点，from 是整个拷一个示例');
  if (tpl && panel) throw new ScaffoldError('panel 只给 basic 骨架用：应用模板自己带页面（或由 bridge 画）');
  // 应用标题先校验再动盘：撞了 bridge 自带入口名的话，生成出来的插件会被体检丢掉应用
  const appTitle = tpl ? [...String(name || id).replace(/[\r\n]+/g, ' ').trim()].slice(0, 20).join('') || id.slice(0, 20) : '';
  if (tpl && isReservedTitle(appTitle)) throw new ScaffoldError('应用标题「' + appTitle + '」和 bridge 自带的入口重名，换个 name');
  const target = path.resolve(String(dir));
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new ScaffoldError('目标已存在且不是目录：' + target);
    if (readdirSync(target).length) throw new ScaffoldError('目录已存在且不是空的：' + target + '（换个目录或 id）');
  }
  if (from) {
    if (!Object.hasOwn(EXAMPLES, from)) throw new ScaffoldError('没有示例「' + from + '」（可用：' + Object.keys(EXAMPLES).join(' / ') + '）');
    copyExample(from, target, id);
  } else if (tpl) {
    writeTemplate(tpl, target, id, appTitle, String(description || ''));
  } else {
    writeSkeleton(target, id, !!panel);
  }
  // 名字 / 说明
  const mf = path.join(target, 'bridge-plugin.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  if (name) m.name = String(name).slice(0, 60);
  if (description) m.description = String(description).slice(0, 500);
  if ((from || tpl) && !name) m.name = id;
  writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
  return { dir: target, files: listFiles(target) };
}

function copyExample(from, target, id) {
  mkdirSync(target, { recursive: true });
  cpSync(path.join(EXAMPLES_DIR, from), target, { recursive: true });
  const oldGid = from.replace(/-/g, '_');
  const newGid = id.replace(/-/g, '_');
  for (const rel of listFiles(target)) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
    const f = path.join(target, rel);
    const s = readFileSync(f, 'utf8');
    const t = s.split(from).join(id).split(oldGid).join(newGid);
    if (t !== s) writeFileSync(f, t);
  }
}

function writeSkeleton(dir, id, panel) {
  const gid = id.replace(/-/g, '_');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify({
    id,
    name: id,
    version: '0.1.0',
    description: '一句话说明这个插件做什么。',
    entry: 'index.mjs',
    engines: { pluginApi: 3 },
    permissions: ['routes', 'claude.tools'],
    config: {
      message: { type: 'string', label: '示例设置', default: '你好', desc: '设置页会按这里自动生成表单' },
    },
    ...(panel ? { ui: { panel: { page: 'web/index.html', title: id, icon: 'puzzle' } } } : {}),
  }, null, 2) + '\n');

  writeFileSync(path.join(dir, 'index.mjs'), `// ${id}：bridge 插件。写法见 bridge 项目手册的「插件」章（bridge 工具 manual topic=plugins）。
// apply 在插件启用时调用一次；经 ctx 登记的东西在停用 / 改配置 / 重新加载时自动撤掉。

export function apply(ctx, config) {
  // 接口：GET /api/plugin/${id}/hello（要登录）
  ctx.route('GET', '/api/plugin/${id}/hello', (req, res) => {
    if (!ctx.http.user(req, res)) return;
    ctx.http.json(res, 200, { message: ctx.config.message });
  });

  // 给 Claude 的工具：mcp__${id}__hello
  ctx.claude.tool({
    name: 'hello',
    description: '示例工具：返回插件配置里的 message。',
    access: 'read',
    params: { name: { type: 'string', desc: '可选：对谁说' } },
    handler: ({ name }) => (name ? name + '，' : '') + ctx.config.message,
  });

  // agent 接口操作：${gid}.status
  ctx.agentOp({ name: 'status', title: '${id} 的状态', handler: () => ({ ok: true, message: ctx.config.message }) });

  // 设置页插件详情顶上的状态块（ctx.status.refresh() 立刻刷新）
  ctx.status(() => ({ tone: 'ok', text: '运行中', items: [{ label: '示例设置', value: ctx.config.message }] }));

  // 改设置时不重启插件，只换配置（不登记就整个重启）。所以上面都从 ctx.config 读最新值。
  ctx.onConfig(() => { ctx.status.refresh(); });

  ctx.log('已启用');   // 详情页「日志」里看得到
}
`);

  if (panel) {
    mkdirSync(path.join(dir, 'web'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${id}</title>
<link rel="stylesheet" href="/plugins/_sdk/bridge-plugin.css">
</head>
<body>
<main class="bp-page">
  <h1 class="bp-h1">${id}</h1>
  <p class="bp-muted">插件的控制面板。页面跑在不透明源里：调接口用 bridge.json / bridge.fetch（自动带凭证），别用裸 fetch。</p>
  <div class="bp-section">
    <div class="bp-group">
      <div class="bp-row"><div class="bp-row-main"><div class="bp-row-title">示例设置</div><div class="bp-row-desc" id="msg">…</div></div>
        <button class="bp-btn" id="again">刷新</button></div>
    </div>
  </div>
</main>
<script type="module">
  import { bridge } from '/plugins/_sdk/bridge-plugin.js';
  const load = async () => { document.getElementById('msg').textContent = (await bridge.json('hello')).message; };
  document.getElementById('again').onclick = () => load().then(() => bridge.toast('已刷新'));
  await bridge.ready();
  load();
</script>
</body>
</html>
`);
  }

  writeFileSync(path.join(dir, 'README.md'), `# ${id}

bridge 插件。

- 登记：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填 \`${dir}\`（或让 bridge 里的 Claude 调 plugins.link）
- 改完代码：在插件详情里点「重新加载」（或 plugins.reload）
- 打包分发：把这个目录打成 zip，在 添加 › 上传 zip 里装
`);
}

// ── 应用模板 ─────────────────────────────────────────────────────────────
// 生成的文件里不用 ${}：模板正文用 String.raw 写死，只替换 __占位__（id / 标题 / 说明），免得转义两层看花眼。
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fill = (body, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(k).join(v), body);
// 英文标题：插件 id 拆词首字母大写（my-notes → My notes），≤30 字
const enTitle = (id) => { const t = id.replace(/-/g, ' ').slice(0, 30).trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

// 深浅两枚 64×64 线稿图标（浅色界面用 light = 深色线条，深色界面用 dark = 浅色线条），配色同 hello-app
const GLYPHS = {
  page: (ink, accent) => `<rect x="10" y="10" width="44" height="44" rx="12" stroke="${ink}" stroke-width="3.2"/>
  <rect x="20" y="20" width="10" height="10" rx="3" stroke="${ink}" stroke-width="3"/>
  <rect x="34" y="20" width="10" height="10" rx="3" fill="${accent}"/>
  <rect x="20" y="34" width="10" height="10" rx="3" stroke="${ink}" stroke-width="3"/>
  <rect x="34" y="34" width="10" height="10" rx="3" stroke="${ink}" stroke-width="3"/>`,
  view: (ink, accent) => `<rect x="10" y="10" width="44" height="44" rx="12" stroke="${ink}" stroke-width="3.2"/>
  <circle cx="22" cy="24" r="3" fill="${accent}"/>
  <path d="M29 24h14M29 32h14M29 40h9" stroke="${ink}" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="22" cy="32" r="2.4" fill="${ink}"/>
  <circle cx="22" cy="40" r="2.4" fill="${ink}"/>`,
  chat: (ink, accent) => `<path d="M16 13h32a8 8 0 0 1 8 8v17a8 8 0 0 1-8 8H32l-10.5 7.5V46H16a8 8 0 0 1-8-8V21a8 8 0 0 1 8-8z" stroke="${ink}" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M21 26h22M21 33h14" stroke="${accent}" stroke-width="3.2" stroke-linecap="round"/>`,
};
function writeIcons(dir, glyph) {
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  const svg = (ink, accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" fill="none">
  ${GLYPHS[glyph](ink, accent)}
</svg>
`;
  writeFileSync(path.join(dir, 'web', 'icon-light.svg'), svg('#26262b', '#d97757'));
  writeFileSync(path.join(dir, 'web', 'icon-dark.svg'), svg('#f2f2f4', '#ec9a7c'));
}

const ICON_REF = { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' };

function writeTemplate(tpl, dir, id, title, description) {
  mkdirSync(dir, { recursive: true });
  const vars = { __ID__: id, __TITLE_JS__: JSON.stringify(title), __TITLE_HTML__: htmlEsc(title), __TITLE__: title };
  const write = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), fill(body, vars));
  };
  const app = { id: 'main', title, titleEn: enTitle(id), ...(tpl === 'app-view' ? {} : { page: 'web/app.html' }), icon: ICON_REF, who: 'host', order: 0 };
  const manifest = {
    id,
    name: title,
    version: '0.1.0',
    description: description || TEMPLATES[tpl].split('：')[0] + '。',
    ...(tpl === 'app-view' ? { entry: 'index.mjs' } : {}),
    engines: { pluginApi: 3 },
    permissions: tpl === 'app-chat' ? ['ui', 'page.chat'] : ['ui'],
    // 声明式应用的 view 是函数，只能在 index.mjs 里登记；页面应用写在清单里
    ...(tpl === 'app-view' ? {} : { ui: { apps: [app] } }),
  };
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  write('locales/en.json', JSON.stringify({ name: enTitle(id), description: 'An app for bridge.', ui: { app: { main: { title: enTitle(id) } } } }, null, 2) + '\n');
  writeIcons(dir, tpl === 'app-page' ? 'page' : tpl === 'app-view' ? 'view' : 'chat');
  if (tpl === 'app-page') { write('web/app.html', TPL_PAGE_HTML); write('README.md', TPL_README_PAGE); }
  else if (tpl === 'app-view') { write('index.mjs', TPL_VIEW_INDEX); write('README.md', TPL_README_VIEW); }
  else { write('web/app.html', TPL_CHAT_HTML); write('README.md', TPL_README_CHAT); }
}

const TPL_PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__TITLE_HTML__</title>
<link rel="stylesheet" href="/plugins/_sdk/bridge-plugin.css">
<style>
  .hero { display: flex; align-items: center; gap: 14px; margin: 4px 0 20px; }
  .hero img { width: 52px; height: 52px; flex: none; }
  .count { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main class="bp-page">
  <div class="hero">
    <img id="icon" alt="">
    <div>
      <h1 class="bp-h1">__TITLE_HTML__</h1>
      <p class="bp-muted">从这里开始写你的应用。页面跑在不透明源里：调插件接口用 bridge.json / bridge.fetch，存小数据用 bridge.kv。</p>
    </div>
  </div>
  <div class="bp-section" id="kvBox" hidden>
    <div class="bp-section-title">计数器（bridge.kv）</div>
    <div class="bp-group">
      <div class="bp-row">
        <div class="bp-row-main">
          <div class="count" id="count">0</div>
          <div class="bp-row-desc">存在服务器上、每个使用者一份，刷新页面、换台设备打开都还在。</div>
        </div>
        <button class="bp-btn bp-btn-primary" id="inc">+1</button>
      </div>
    </div>
  </div>
</main>
<script type="module">
  import { bridge } from '/plugins/_sdk/bridge-plugin.js';
  const $ = (id) => document.getElementById(id);
  // 图标的 light / dark 按「显示它的界面」命名：浅色界面用 light（深色线条），深色界面用 dark（浅色线条）
  const paintIcon = () => { $('icon').src = document.documentElement.dataset.theme === 'light' ? 'icon-light.svg' : 'icon-dark.svg'; };
  await bridge.ready();     // 先等宿主把主题、语言、身份交过来
  paintIcon();
  bridge.onTheme(paintIcon);
  // 老版本 bridge 的 SDK 没有 can()：当作不支持，把那块藏着
  if (typeof bridge.can === 'function' && bridge.can('kv')) {
    $('kvBox').hidden = false;
    let n = Number(await bridge.kv.get('count').catch(() => 0)) || 0;
    $('count').textContent = String(n);
    $('inc').onclick = async () => {
      n += 1;
      $('count').textContent = String(n);
      try { await bridge.kv.set('count', n); } catch (e) { bridge.toast(e?.message || String(e), { error: true }); }
    };
  }
</script>
</body>
</html>
`;

const TPL_CHAT_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__TITLE_HTML__</title>
<link rel="stylesheet" href="/plugins/_sdk/bridge-plugin.css">
<style>
  .log { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; min-height: 30vh; max-height: 60vh; overflow-y: auto; }
  .msg { font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg .who { display: block; font-size: 12px; color: var(--bp-muted); margin-bottom: 2px; }
  .msg.user { align-self: flex-end; max-width: 85%; background: var(--bp-hover); border-radius: 10px; padding: 6px 10px; }
  .msg.note { font-size: 12.5px; color: var(--bp-muted); }
  .msg.err { font-size: 13px; color: var(--bp-crit); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main class="bp-page">
  <h1 class="bp-h1">__TITLE_HTML__</h1>
  <p class="bp-muted" id="nocaps" hidden>这台 bridge 还不支持页面对话（bridge.chat），升级后再来。</p>
  <div class="bp-section" id="chatBox" hidden>
    <div class="bp-group">
      <div class="log" id="log"><div class="bp-empty">以你的身份开一个真会话，Claude 分页的会话列表里也看得到它。</div></div>
      <div class="bp-row bp-row-stack">
        <textarea class="bp-textarea" id="prompt" rows="2" placeholder="说点什么…"></textarea>
        <div class="actions">
          <button class="bp-btn bp-btn-primary" id="send">发送</button>
          <button class="bp-btn" id="stop" hidden>停止</button>
          <button class="bp-btn bp-btn-plain" id="newChat" hidden>新对话</button>
          <button class="bp-btn bp-btn-plain" id="openChat" hidden>在 Claude 分页打开</button>
        </div>
      </div>
    </div>
  </div>
</main>
<script type="module">
  import { bridge } from '/plugins/_sdk/bridge-plugin.js';
  const $ = (id) => document.getElementById(id);
  await bridge.ready();
  const can = (name) => typeof bridge.can === 'function' && bridge.can(name);
  const fail = (e) => bridge.toast(e?.message || String(e), { error: true });
  if (!can('chat')) { $('nocaps').hidden = false; throw new Error('no chat'); }
  $('chatBox').hidden = false;

  const log = $('log');
  let sid = null;          // 会话 id：记在 bridge.kv 里，刷新页面接着聊
  let off = null;
  let cur = null;          // 正在往里拼增量的那条回复
  let replayUntil = 0;
  const add = (cls, who, text) => {
    log.querySelector('.bp-empty')?.remove();
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who; d.append(w); }
    const body = document.createElement('span');
    body.textContent = text || '';
    d.append(body);
    d.body = body;
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };
  const paintButtons = () => { $('newChat').hidden = !sid; $('openChat').hidden = !sid || !can('nav'); };
  // 订阅一连上，服务端先补发正在跑的那一轮（问话 + 已写下的半截回复）；刚从历史画过的那段以补发的为准，免得画两遍
  const dropReplayedTail = (userText) => {
    const users = [...log.querySelectorAll('.msg.user')];
    const last = users[users.length - 1];
    if (!last || last.body.textContent !== userText) return;
    while (last.nextSibling) last.nextSibling.remove();
    last.remove();
  };
  const onEvent = (ev) => {
    if (ev.type === 'turn') {
      if (Date.now() < replayUntil) dropReplayedTail(ev.userText);
      replayUntil = 0;
      add('user', '你', ev.userText); cur = null; $('stop').hidden = false;
    }
    else if (ev.type === 'text') { if (!cur) cur = add('assistant', 'Claude', ''); cur.body.textContent += ev.text; log.scrollTop = log.scrollHeight; }
    else if (ev.type === 'tool' && ev.status === 'start') { add('note', '', '正在用 ' + ev.name + '…'); cur = null; }
    // 页面不能代批：提示去 Claude 分页
    else if (ev.type === 'approval') add('note', '', 'Claude 在等你批准，去 Claude 分页处理');
    else if (ev.type === 'done') { if (!cur && ev.ok && ev.result) add('assistant', 'Claude', ev.result); cur = null; $('stop').hidden = true; }
    // kind:'stream' = 订阅被切断（撤销了对话权限、插件停用……），SDK 不再重连：清掉，下次发送后重新订
    else if (ev.type === 'error') { add('err', '', ev.message || ev.kind); $('stop').hidden = true; if (ev.kind === 'stream') off = null; }
  };
  const subscribe = () => { off?.(); replayUntil = Date.now() + 3000; off = bridge.chat.on(sid, onEvent); };

  $('send').onclick = async () => {
    const text = $('prompt').value.trim();
    if (!text) return;
    $('send').disabled = true;
    try {
      if (!sid) {
        // 第一句开会话：没授权时 SDK 先弹 bridge 自己的授权框（清单里声明了 page.chat）
        sid = (await bridge.chat.start({ prompt: text })).sessionId;
        if (can('kv')) bridge.kv.set('chat.session', sid).catch(() => {});
        subscribe();
        paintButtons();
      } else {
        const r = await bridge.chat.send(sid, text);
        // 订阅被切断过就在发出之后重订（这时人已经重新同意了）；连上时服务端先补发正在跑的这一轮，晚订不会漏
        if (!off) subscribe();
        if (r?.queued) add('note', '', '上一轮还没完，这句排上队了');
      }
      $('prompt').value = '';
    } catch (e) { fail(e); } finally { $('send').disabled = false; }
  };
  $('prompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('send').click(); };
  $('stop').onclick = () => { if (sid) bridge.chat.stop(sid).catch(fail); };
  $('openChat').onclick = () => { if (sid) bridge.nav.session(sid); };
  $('newChat').onclick = () => {
    off?.(); off = null; sid = null; cur = null;
    if (can('kv')) bridge.kv.set('chat.session', null).catch(() => {});
    log.innerHTML = '';
    paintButtons();
  };

  // 刷新页面：把上次的会话画回来再接着订阅；会话不在了就当新对话
  const saved = can('kv') ? await bridge.kv.get('chat.session').catch(() => null) : null;
  if (saved) {
    try {
      const { messages } = await bridge.chat.history(saved);
      sid = saved;
      for (const m of messages) add(m.role === 'user' ? 'user' : 'assistant', m.role === 'user' ? '你' : 'Claude', m.text);
      subscribe();
    } catch {}
  }
  paintButtons();
</script>
</body>
</html>
`;

const TPL_VIEW_INDEX = String.raw`// __ID__：bridge 声明式应用。不写页面：view 回一组积木，bridge 自己画（网页和手机 App 一个样）；
// 积木上的按钮 / 开关 / 表单按下去，调 actions 里的同名函数，然后 bridge 用新 state 再调一次 view 重画。
// 写法与积木表见 bridge 项目手册「插件」章的「做一个应用」（bridge 里的 Claude 用 bridge 工具 manual topic=plugins 读）。
//
// 数据放哪：
//   ctx.store —— 存在服务器上，重开应用、换设备都在（这里的待办清单）；
//   state     —— 只是界面状态（当前标签页），前端保管、每次随请求带上来：别拿它判断权限，也别放大数据（上限 256 KB）。

export function apply(ctx) {
  const load = () => ctx.store.get('items', []);
  const save = (items) => { ctx.store.set('items', items); };

  ctx.ui.app({
    id: 'main',
    title: __TITLE_JS__,
    icon: { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' },
    who: 'host',                  // 'members' = 成员也能用（数据仍是这一份：要按人分开就用 who.user 当键）
    state: { tab: 'open' },       // 初始界面状态
    view: (who, { state }) => {
      const items = load();
      const open = items.filter((x) => !x.done);
      const shown = state.tab === 'done' ? items.filter((x) => x.done) : state.tab === 'all' ? items : open;
      return [
        { type: 'stat', items: [
          { label: '待办', value: String(open.length) },
          { label: '已完成', value: String(items.length - open.length), tone: 'ok' },
        ] },
        { type: 'tabs', value: state.tab, action: 'tab', items: [
          { id: 'open', label: '待办' }, { id: 'done', label: '已完成' }, { id: 'all', label: '全部' },
        ] },
        { type: 'list', empty: '这里还是空的', items: shown.map((x) => ({
          id: x.id, title: x.text, desc: x.done ? '已完成' : '',
          trailing: { type: 'switch', value: x.done, action: 'toggle' },
        })) },
        { type: 'form', id: 'add',
          fields: { text: { type: 'string', label: '新待办', placeholder: '写点什么…', required: true } },
          submit: { label: '添加', action: 'add' } },
        { type: 'button', label: '清掉已完成', style: 'danger', action: 'clearDone', confirm: '已完成的都删掉？' },
      ];
    },
    // 动作回：字符串（当提示）| { state?, toast?, nav? }；什么都不回 = 只重画
    // 积木调动作时 args 自动并入：标签页 { tab }、开关 { value }、列表行 { id }、表单 { values }
    actions: {
      tab: (who, { args, state }) => ({ state: { ...state, tab: args.tab } }),
      add: (who, { args }) => {
        const text = String(args.values?.text || '').trim().slice(0, 120);
        if (!text) return '先写点内容';
        save([...load(), { id: Date.now().toString(36), text, done: false }]);
        return { toast: '已添加' };
      },
      toggle: (who, { args }) => {
        save(load().map((x) => (x.id === args.id ? { ...x, done: args.value === true } : x)));
      },
      clearDone: () => {
        const items = load();
        const left = items.filter((x) => !x.done);
        save(left);
        return '清掉了 ' + (items.length - left.length) + ' 条';
      },
    },
  });
}
`;

const TPL_README_COMMON = String.raw`
## 装上、改、看

- 登记：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填这个目录的绝对路径（或让 bridge 里的 Claude 调 plugins.link）。
- 改完：在插件详情里点「重新加载」（或 plugins.reload），回主页就能看到「__TITLE__」。
- 带人过去：bridge 里的 Claude 用 ui.open 的 app 参数（__ID__:main）直接打开这个应用。
- 打包分发：把这个目录打成 zip，在 添加 › 上传 zip 里装。

英文界面的名字与应用标题在 locales/en.json；图标在 web/icon-light.svg（浅色界面用）与 web/icon-dark.svg（深色界面用）。
完整写法见 bridge 项目手册「插件」章的「做一个应用」一节。
`;
const TPL_README_PAGE = String.raw`# __TITLE__

bridge 页面应用：纯页面插件（没有 index.mjs），清单 bridge-plugin.json 的 ui.apps 在主页加一个图标，点开是 web/app.html 全屏分页。

- 页面里调 bridge 的能力用 /plugins/_sdk/bridge-plugin.js（bridge.kv 存小数据、bridge.chat 和 Claude 对话、bridge.pick.file 读写用户选的文件）。
- 要服务端接口：加一个 index.mjs（export function apply(ctx) { … }），页面里用 bridge.json 调 /api/plugin/__ID__/…。
` + TPL_README_COMMON;
const TPL_README_VIEW = String.raw`# __TITLE__

bridge 声明式应用：不写页面。index.mjs 里 ctx.ui.app 登记 view（回积木列表）与 actions，bridge 自己画界面，网页与手机 App 一个样。

- 积木：text、markdown、section、stat、list、table、form、chart、button、buttons、tabs、empty、image、divider、chat。
- 数据存 ctx.store（服务器上）；state 只放界面状态，由前端保管、随请求带上来，不能拿它判断权限。
- 插件那头数据变了（定时任务、外部回调）：调 ctx.ui.refresh('main') 让开着的页面重拉。
` + TPL_README_COMMON;
const TPL_README_CHAT = String.raw`# __TITLE__

bridge 对话应用：页面应用 + page.chat 权限。web/app.html 里一个对话区，以使用者的身份开真会话（Claude 分页的会话列表里也看得到）。

- bridge.chat.start 开会话（第一次用时 bridge 弹自己的授权框）、bridge.chat.send 接着说、bridge.chat.on 收流式事件、bridge.chat.stop 停。
- 会话 id 记在 bridge.kv，刷新页面接着聊；要审批时页面不能代批，提示去 Claude 分页。
` + TPL_README_COMMON;
