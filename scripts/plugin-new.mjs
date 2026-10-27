#!/usr/bin/env node
// 新建一个 bridge 插件骨架：npm run plugin:new -- <id> [目录] [--panel] [--from <示例>]
//   id       小写字母开头，只用小写字母、数字、连字符（如 weather、my-notes）
//   目录     缺省 = 当前目录下的 <id>/
//   --panel  再带一个控制面板页面（web/index.html，用 /plugins/_sdk/bridge-plugin.js），设置侧栏「插件」组里出现
//   --from   拿示例当起点：hello-world / qq-onebot（src/plugins/examples/，id 换成新的）
// 生成逻辑在 src/plugins/scaffold.mjs（agent 操作 plugins.scaffold 用的同一份）。
// 生成后在 设置 › 扩展 › 功能扩展 › 添加 › 本机目录 里登记它（或让 bridge 里的 Claude 调 plugins.link），改代码点「重新加载」。

import path from 'node:path';
import { scaffoldPlugin, EXAMPLES, ScaffoldError } from '../src/plugins/scaffold.mjs';

const argv = process.argv.slice(2);
const panel = argv.includes('--panel');
const fi = argv.indexOf('--from');
const from = fi >= 0 ? argv[fi + 1] : null;
const [id, dirArg] = argv.filter((a, i) => a !== '--panel' && i !== fi && i !== fi + 1);
try {
  const r = scaffoldPlugin({ id, dir: path.resolve(dirArg || id || '.'), panel, from });
  console.log('已生成插件骨架：' + r.dir + '\n  ' + r.files.join('\n  '));
  console.log('下一步：设置 › 扩展 › 功能扩展 › 添加 › 本机目录，填上面这个路径（或让 bridge 里的 Claude 调 plugins.link）。');
} catch (e) {
  if (!(e instanceof ScaffoldError)) throw e;
  console.error(e.message + '\n用法：npm run plugin:new -- <id> [目录] [--panel] [--from ' + Object.keys(EXAMPLES).join('|') + ']');
  process.exit(1);
}
