#!/usr/bin/env node
// 新建一个 bridge 插件骨架：npm run plugin:new -- <id> [目录] [--panel] [--from <示例> | --template <模板>] [--name <显示名>]
//   id       小写字母开头，只用小写字母、数字、连字符（如 weather、my-notes）
//   目录     缺省 = 当前目录下的 <id>/
//   --panel  再带一个控制面板页面（web/index.html，用 /plugins/_sdk/bridge-plugin.js），设置侧栏「插件」组里出现
//   --from   拿示例当起点：hello-world / hello-app（纯页面应用，没有 index.mjs）/ hello-view（声明式应用）/ qq-onebot / power-tools
//            （src/plugins/examples/，id 换成新的）。名单以 scaffold.mjs 的 EXAMPLES 为准，加示例时这里一起改；
//            用法提示里的名单是从 EXAMPLES 现拼的，不会过时。
//   --template  做「应用」的起点（与 --from 互斥，名单以 scaffold.mjs 的 TEMPLATES 为准）：app-page 页面应用 /
//            app-view 声明式应用（bridge 按积木画）/ app-chat 和 Claude 对话的应用；basic = 缺省的最小骨架。应用 id 固定为 main。
//   --name   显示名（应用模板拿它当应用标题，≤20 字；缺省用 id）
// 生成逻辑在 src/plugins/scaffold.mjs（agent 操作 plugins.scaffold 用的同一份）。
// 生成后在 设置 › 扩展 › 功能扩展 › 添加 › 本机目录 里登记它（或让 bridge 里的 Claude 调 plugins.link），改代码点「重新加载」。

import path from 'node:path';
import { scaffoldPlugin, EXAMPLES, APP_TEMPLATE_IDS, ScaffoldError } from '../src/plugins/scaffold.mjs';

const argv = process.argv.slice(2);
const panel = argv.includes('--panel');
// 带值的开关：--from x / --template x / --name x（值占下一个位置，不算位置参数）
const taken = new Set();
const opt = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  taken.add(i);
  taken.add(i + 1);
  return argv[i + 1] ?? '';
};
const from = opt('--from');
const template = opt('--template');
const name = opt('--name');
const [id, dirArg] = argv.filter((a, i) => a !== '--panel' && !taken.has(i));
try {
  const r = scaffoldPlugin({ id, dir: path.resolve(dirArg || id || '.'), panel, from, template, name: name || '' });
  console.log('已生成插件骨架：' + r.dir + '\n  ' + r.files.join('\n  '));
  console.log('下一步：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填上面这个路径（或让 bridge 里的 Claude 调 plugins.link）。');
  if (template && template !== 'basic') console.log('这是个应用（' + id + ':main）：登记后回主页就能看到它的图标；改完代码在插件详情里点「重新加载」。');
} catch (e) {
  if (!(e instanceof ScaffoldError)) throw e;
  console.error(e.message + '\n用法：npm run plugin:new -- <id> [目录] [--panel] [--from ' + Object.keys(EXAMPLES).join('|')
    + ' | --template ' + APP_TEMPLATE_IDS.join('|') + '] [--name <显示名>]');
  process.exit(1);
}
