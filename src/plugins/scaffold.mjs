// 新建插件骨架（agent 操作 plugins.scaffold、命令行 npm run plugin:new 共用）。放在 src/ 里，跟着安装包和 Docker 镜像走：
// 没有源码仓库的用户，bridge 里的 Claude 也能一步建好插件目录再登记。
//
// scaffoldPlugin({ id, dir, panel?, from?, name?, description? }) → { dir, files }
//   from 缺省   生成最小骨架：bridge-plugin.json（一项示例配置）、index.mjs（接口 + Claude 工具 + agent 操作 + 状态块）、README.md；
//               panel:true 再带一个控制面板页面 web/index.html（用 /plugins/_sdk/bridge-plugin.js）。
//   from 填示例 把 src/plugins/examples/<示例>/ 整个拷过去，文本文件里的示例 id 换成新 id（下划线形式的 agent 操作组名一起换）。
// 目标目录要么不存在、要么是空的；不覆盖任何已有文件。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'examples');
// 可以拿来当起点的示例（目录名 → 说明）
export const EXAMPLES = Object.freeze({
  'hello-world': '最小完整示例：一个接口、一个给 Claude 的工具、一个 agent 操作、自动生成的设置表单、一个插件页面',
  'qq-onebot': 'QQ 机器人（OneBot 11）：以授权账号跑 Claude（ctx.chat）、收外部推送（ctx.webhook）、托管外部程序（ctx.process）、分组表单 / 按群设置、状态块与动作按钮、控制面板',
});

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

export function scaffoldPlugin({ id, dir, panel = false, from = null, name = '', description = '' }) {
  if (!ID_RE.test(String(id || ''))) throw new ScaffoldError('id 不合法：小写字母开头，只用小写字母、数字、连字符（≤48 字），如 weather、my-notes');
  if (!dir || !path.isAbsolute(String(dir))) throw new ScaffoldError('dir 要写绝对路径');
  const target = path.resolve(String(dir));
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new ScaffoldError('目标已存在且不是目录：' + target);
    if (readdirSync(target).length) throw new ScaffoldError('目录已存在且不是空的：' + target + '（换个目录或 id）');
  }
  if (from) {
    if (!Object.hasOwn(EXAMPLES, from)) throw new ScaffoldError('没有示例「' + from + '」（可用：' + Object.keys(EXAMPLES).join(' / ') + '）');
    copyExample(from, target, id);
  } else {
    writeSkeleton(target, id, !!panel);
  }
  // 名字 / 说明
  const mf = path.join(target, 'bridge-plugin.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  if (name) m.name = String(name).slice(0, 60);
  if (description) m.description = String(description).slice(0, 500);
  if (from && !name) m.name = id;
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
    ctx.http.json(res, 200, { message: config.message });
  });

  // 给 Claude 的工具：mcp__${id}__hello
  ctx.claude.tool({
    name: 'hello',
    description: '示例工具：返回插件配置里的 message。',
    access: 'read',
    params: { name: { type: 'string', desc: '可选：对谁说' } },
    handler: ({ name }) => (name ? name + '，' : '') + config.message,
  });

  // agent 接口操作：${gid}.status
  ctx.agentOp({ name: 'status', title: '${id} 的状态', handler: () => ({ ok: true, message: config.message }) });

  // 设置页插件详情顶上的状态块（ctx.status.refresh() 立刻刷新）
  ctx.status(() => ({ tone: 'ok', text: '运行中', items: [{ label: '示例设置', value: config.message }] }));

  ctx.log('已启用');
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
