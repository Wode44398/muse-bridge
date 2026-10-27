// 示例插件：演示 bridge 插件能做的几件事。复制这个目录、改 bridge-plugin.json 里的 id 和名字，就是你自己插件的起点。
//
// apply(ctx, config) 在插件启用时调用一次；config 是按清单里的 schema 校验、补好默认值的配置。
// 经 ctx 登记的东西（接口、工具、操作、定时器……）在插件停用 / 改配置 / 重新加载时会被自动撤掉，不用自己写清理代码。

import { greetText } from './lib/greet.mjs';

export function apply(ctx, config) {
  let count = 0;
  const greet = (name) => { count++; return greetText(config, name); };

  // 1. 接口：GET /api/plugin/hello-world/greet?name=小明（要登录；第三方插件的接口建议都放在 /api/plugin/<id>/ 下）
  ctx.route('GET', '/api/plugin/hello-world/greet', (req, res, url) => {
    const who = ctx.http.user(req, res);   // 没登录已回 401，返回 null
    if (!who) return;
    ctx.http.json(res, 200, { text: greet(url.searchParams.get('name') || '朋友'), count });
  });

  // 2. 给 Claude 的工具：模型看到的名字是 mcp__hello-world__greet。参数写法与配置 schema 同一套。
  //    access:'read' = 只读，不弹审批卡；会改东西的工具别写 read。who 缺省 'host'（只给服务器主机本人的会话）。
  ctx.claude.tool({
    name: 'greet',
    description: '用插件里配置的问候语跟某人打招呼（示例工具）。',
    access: 'read',
    params: { name: { type: 'string', required: true, desc: '要打招呼的人' } },
    handler: ({ name }) => greet(name),
  });
  if (config.hint) ctx.claude.prompt('你有一个示例工具 mcp__hello-world__greet，用户想打招呼时可以用它。');

  // 3. agent 接口操作：hello_world.stats —— /agent/v1/hello_world.stats、bridge 里 Claude 的 bridge 工具都能调，手册里自动出现。
  ctx.agentOp({
    name: 'stats',
    title: '示例插件被调用了几次',
    desc: '返回接口与 Claude 工具一共被调用的次数（插件重新加载或服务重启后清零）。',
    handler: () => ({ count, greeting: config.greeting }),
  });

  // 4. 后台任务：插件停用时自动清掉
  ctx.setInterval(() => ctx.log('今天已经打了 ' + count + ' 次招呼'), 6 * 60 * 60 * 1000);

  ctx.log('已启用，问候语：' + config.greeting);
}
