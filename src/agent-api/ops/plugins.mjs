// 插件：bridge 的功能都是插件——内置功能（默认套装）、agent 扩展、第三方插件。这组操作看状态、开关、改配置、
// 登记 / 卸载 / 重新加载第三方插件。业务在 plugins/（内核 kernel/），同设置 › 扩展 › 功能扩展页（routes/plugins.mjs）。
// 只有服务器主机能用。写插件的方法见手册 plugins 章（manual topic=plugins）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { kernel } from '../../plugins/state.mjs';
import { linkLocal, uninstallPlugin, reloadPlugin, PluginError } from '../../plugins/discover.mjs';
import { installFromGithub, checkUpdate } from '../../plugins/github.mjs';
import { scaffoldPlugin, EXAMPLES, ScaffoldError } from '../../plugins/scaffold.mjs';
import path from 'node:path';
import { pluginView, pluginsOverview, riskyGrants } from '../../routes/plugins.mjs';
import { panelView, refreshStatuses, runAction } from '../../plugins/panel.mjs';
import { busPublishAll } from '../../runtime/bus.mjs';

defineGroup('plugins', '插件', 'bridge 的功能扩展：内置功能逐项开关、改配置；登记 / 重载 / 卸载第三方插件（写法见手册 plugins 章）。');

const changed = () => busPublishAll({ type: 'plugins.changed' });
const wrap = async (fn) => {
  try { return await fn(); }
  catch (e) {
    if (e instanceof OpError) throw e;
    const status = e instanceof PluginError ? e.status : 400;
    throw new OpError(status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'bad_args', String(e?.message || e));
  }
};
const must = (id) => { if (!kernel.has(id)) throw new OpError('not_found', '没有插件「' + id + '」', { hint: '先 plugins.list 看有哪些' }); };

defineOp({
  name: 'plugins.list', title: '列出插件',
  desc: [
    '每项：id、name、description、category（network / agent-tools / automation / sharing / devices / integration / appearance / system / agent / third-party）、',
    'source（builtin 内置 | module agent 扩展 | installed 装的 | local 本机开发目录）、enabled（该不该开）、active（此刻在不在跑）、',
    'status（active / disabled / blocked 缺依赖 / error）、error、problems（存着的配置哪几项坏了、已退回默认值）、',
    'locked（不能在这里关：核心或 agent 扩展，后者在 Agent 页开关）、restart（改了要重启服务端才生效）、pendingRestart、',
    'requires、schema（配置项：type / default / desc / enum…）、config（当前配置，secret 打码）。restartPending 为 true 表示有改动等重启。',
  ].join(''),
  need: ['server.manage'],
  handler: async () => {
    await refreshStatuses(kernel.list().filter((p) => p.active).map((p) => p.id));
    return pluginsOverview();
  },
});

defineOp({
  name: 'plugins.status', title: '看一个插件的运行状态',
  desc: '插件自报的状态块（status：tone ok / warn / error / idle、text、items）、它托管的子进程（processes：state、pid、restarts、lastExit）、'
    + '入站回调地址（hooks）、可用的动作按钮（actions）。logs=子进程名时附上该子进程最后 200 行日志。',
  access: 'read', need: ['server.manage'],
  params: {
    id: { type: 'string', required: true, desc: '插件 id' },
    logs: { type: 'string', desc: '可选：子进程名，附上它的日志尾巴' },
  },
  handler: (ctx, args) => wrap(async () => {
    must(args.id);
    await refreshStatuses([args.id]);
    const { panelStatus, optionFields, ...rest } = panelView(args.id);
    const out = { id: args.id, active: kernel.isActive(args.id), status: panelStatus || null, ...rest };
    if (args.logs) {
      const h = kernel.contextOf(args.id)?.process?.get(args.logs);
      if (!h) throw new OpError('not_found', '没有子进程「' + args.logs + '」');
      out.log = h.tail(200);
    }
    return out;
  }),
});

defineOp({
  name: 'plugins.action', title: '按插件的动作按钮',
  desc: '执行插件用 ctx.action 登记的动作（如「重启连接端」）。先 plugins.status 看 actions；带 confirm 的动作是插件认为要先问用户的，照做。',
  access: 'write', need: ['server.manage'],
  params: {
    id: { type: 'string', required: true, desc: '插件 id' },
    action: { type: 'string', required: true, desc: '动作 id' },
    args: { type: 'object', desc: '可选：传给动作的参数' },
  },
  handler: (ctx, args) => wrap(async () => {
    must(args.id);
    if (!kernel.isActive(args.id)) throw new OpError('conflict', '插件没开着');
    try { return await runAction(args.id, args.action, ctx, args.args || {}); }
    catch (e) { throw new OpError(e.status === 404 ? 'not_found' : 'failed', String(e?.message || e)); }
  }),
});

defineOp({
  name: 'plugins.toggle', title: '打开 / 关闭一个插件',
  desc: '热插件当场生效（路由、Claude 工具、后台任务一并挂上 / 摘下）；restart 为 true 的只落盘，重启服务端后生效。'
    + '关掉一个插件会连带停掉依赖它的插件。关掉用户正在用的功能前先问用户。',
  access: 'write', need: ['server.manage'],
  params: {
    id: { type: 'string', required: true, desc: '插件 id' },
    enabled: { type: 'boolean', required: true, desc: 'true 打开 / false 关闭' },
  },
  example: { id: 'wallpapers', enabled: false },
  handler: (ctx, args) => wrap(async () => {
    must(args.id);
    const p = await kernel.setEnabled(args.id, args.enabled);
    changed();
    return { plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.config', title: '改插件的配置',
  desc: '按插件的 schema 校验（错一项整体拒，返回哪一项错在哪）；只传要改的那几项也行——没传的回到默认值，所以一般先 plugins.list 取当前 config 改完整体传回。'
    + 'secret 项传打码串「••••••••」= 沿用旧值。热插件当场重启生效。',
  access: 'write', need: ['server.manage'],
  params: {
    id: { type: 'string', required: true, desc: '插件 id' },
    config: { type: 'object', required: true, desc: '新配置 { 字段: 值 }' },
    confirmGrant: { type: 'boolean', desc: '授权字段（type user + grant chat）新选了服务器主机或 Pro 档账号时必须带 true——先问过用户再带' },
  },
  handler: (ctx, args) => wrap(async () => {
    must(args.id);
    const risky = args.confirmGrant ? [] : riskyGrants(args.id, args.config);
    if (risky.length) {
      throw new OpError('conflict', '这次配置把「' + risky.map((a) => a.name).join('、') + '」授权给插件以它的身份跑 Claude（有命令行、权限大）', { hint: '先问用户同不同意；同意后带 confirmGrant: true 重试' });
    }
    const p = await kernel.setConfig(args.id, args.config);
    changed();
    return { plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.link', title: '登记一个本机插件目录',
  desc: '把服务器上的一个插件目录（含 bridge-plugin.json 与入口 index.mjs）登记成插件并按清单启用，代码直接从那个目录加载——'
    + '改完代码调 plugins.reload 即生效，不用打包。给用户写插件时：先在工作空间里写好目录，再用它登记。',
  access: 'write', need: ['server.manage'],
  params: { path: { type: 'string', required: true, desc: '插件目录的绝对路径（服务器上的）' } },
  handler: (ctx, args) => wrap(async () => {
    const p = await linkLocal(kernel, args.path);
    changed();
    return { plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.install_github', title: '从 GitHub 装一个插件',
  desc: '下载并安装 GitHub 仓库里的插件：没写 ref 用最新 Release（有 .zip 资产用资产），没发过 Release 用默认分支；覆盖安装同 id 的已装插件 = 升级。'
    + '插件和 bridge 同进程、权限相同——只装用户点名要装、信得过的仓库，装之前先跟用户确认。',
  access: 'danger', need: ['server.manage'],
  params: { repo: { type: 'string', required: true, desc: 'owner/repo、owner/repo@ref，或仓库网址' } },
  example: { repo: 'someone/bridge-weather' },
  handler: (ctx, args) => wrap(async () => {
    const p = await installFromGithub(kernel, args.repo);
    changed();
    return { plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.check_update', title: '检查 GitHub 插件有没有新版',
  desc: '只对从 GitHub 装的插件有效：比最新 Release 的版本号和已装的清单版本。newer 为 true 时用 plugins.install_github 装同一个仓库即升级。',
  access: 'read', need: ['server.manage'],
  params: { id: { type: 'string', required: true, desc: '插件 id' } },
  handler: (ctx, args) => wrap(async () => { must(args.id); return checkUpdate(kernel, args.id); }),
});

defineOp({
  name: 'plugins.scaffold', title: '新建一个插件骨架（可直接登记）',
  desc: '在服务器上建好插件目录并（缺省）登记启用——给用户写插件的第一步。缺省目录 = 你工作空间下的 plugins-dev/<id>/（已存在且非空就拒）。'
    + 'from 不填：最小骨架（清单 + 接口 + Claude 工具 + agent 操作 + 状态块；panel=true 再带一个控制面板页面）；'
    + 'from 填示例名：把示例整个拷过来当起点（id 换成新的）：' + Object.entries(EXAMPLES).map(([k, v]) => `${k}（${v}）`).join('；') + '。'
    + '建好后照手册 plugins 章改 bridge-plugin.json 与 index.mjs，改完调 plugins.reload。插件给 Claude 的工具要下一条消息才出现。',
  access: 'write', need: ['server.manage'],
  params: {
    id: { type: 'string', required: true, desc: '插件 id：小写字母开头，只用小写字母、数字、连字符（≤48 字）' },
    from: { type: 'string', enum: Object.keys(EXAMPLES), desc: '可选：拿哪个示例当起点' },
    panel: { type: 'boolean', desc: '可选：最小骨架再带一个控制面板页面（from 不填时有效）' },
    name: { type: 'string', desc: '可选：显示名' },
    description: { type: 'string', desc: '可选：一句话说明' },
    dir: { type: 'string', desc: '可选：插件目录的绝对路径（服务器上的），缺省 <工作空间>/plugins-dev/<id>' },
    link: { type: 'boolean', desc: '可选：建好就登记启用，缺省 true' },
  },
  example: { id: 'weather', panel: true, name: '天气' },
  handler: (ctx, args) => wrap(async () => {
    const dir = args.dir ? String(args.dir) : path.join(ctx.cwd, 'plugins-dev', String(args.id || ''));
    let r;
    try { r = scaffoldPlugin({ id: args.id, dir, panel: !!args.panel, from: args.from || null, name: args.name || '', description: args.description || '' }); }
    catch (e) { if (e instanceof ScaffoldError) throw new OpError('bad_args', e.message); throw e; }
    if (args.link === false) return { dir: r.dir, files: r.files, linked: false, next: '调 plugins.link {path} 登记' };
    const p = await linkLocal(kernel, r.dir);
    changed();
    return { dir: r.dir, files: r.files, linked: true, plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.reload', title: '重新加载第三方插件',
  desc: '重读清单与代码（整个插件目录里的模块都换成新的），按当前配置重新启用。只对装的 / 本机目录的插件有效；内置功能随程序更新。'
    + '启用失败时返回的 plugin.status 是 error、plugin.error 写着原因（语法错、apply 抛错……）。',
  access: 'write', need: ['server.manage'],
  params: { id: { type: 'string', required: true, desc: '插件 id' } },
  handler: (ctx, args) => wrap(async () => {
    const p = await reloadPlugin(kernel, args.id);
    changed();
    return { plugin: pluginView(p) };
  }),
});

defineOp({
  name: 'plugins.uninstall', title: '卸载第三方插件',
  desc: '装的插件：停用后把目录移进回收区（数据根 plugins/.trash，留最近 3 份）；本机目录：只取消登记，不删你的文件。内置功能只能关、不能卸。',
  access: 'danger', need: ['server.manage'],
  params: { id: { type: 'string', required: true, desc: '插件 id' } },
  handler: (ctx, args) => wrap(async () => {
    await uninstallPlugin(kernel, args.id);
    changed();
    return { id: args.id, removed: true };
  }),
});
