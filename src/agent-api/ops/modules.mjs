// 功能扩展（Gemini · Vertex / ChatGPT · Codex / dimensio）：看装没装、能不能从 GitHub 装，一键安装 / 更新。
// 同扩展中心「功能扩展」页（routes/modules.mjs），业务在 modules/remote.mjs 与 modules/manage.mjs。只有服务器主机能用。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { MODULE_CATALOG } from '../../modules/registry.mjs';
import { modulesOverviewRemote, installFromRelease } from '../../modules/remote.mjs';

defineGroup('modules', '功能扩展', 'Gemini · Vertex、ChatGPT · Codex、dimensio 三个可选模块：查看状态，从 GitHub 发版一键安装 / 更新（重启服务端后生效）。');

const RESTART_HINT = '重启服务端后生效：设置 › 扩展 › 功能扩展 ›「立即重启」，或服务端控制台 › 服务控制';
const CODE_OF = { 400: 'bad_args', 404: 'not_found', 409: 'conflict', 503: 'unavailable', 504: 'timeout' };

defineOp({
  name: 'modules.list', title: '列出功能扩展',
  desc: [
    '每项：id、label、installed（装没装）、loaded、version、builtin（随主程序内置，不能另装卸）、enabled（agent 开没开）、pending（重启后要装 / 卸）、',
    'remote（能不能从 GitHub 装：action 为 install / update 时可调 modules.install，version 是可装的版本；action 为 null 时 reason 写着为什么不能，',
    '如源码部署、这一版不提供、没在 GitHub 公开发布、连不上 GitHub、发版里没有这个扩展）、job（正在装的进度）。',
    'release 是这一版发版来源的总体结论；restartNeeded 为 true 表示有改动等重启。公开版不提供 ChatGPT · Codex，不列出。',
  ].join(''),
  need: ['server.manage'],
  params: { refresh: { type: 'boolean', default: false, desc: '不看缓存，重新查询 GitHub' } },
  handler: async (ctx, args) => {
    const ov = await modulesOverviewRemote({ refresh: args.refresh, waitMs: 15_000 });
    return {
      buildId: ov.buildId, release: ov.release, restartNeeded: ov.restartNeeded,
      modules: ov.modules.map(({ id, label, agents, installed, loaded, version, builtin, enabled, error, pending, remote, job }) =>
        ({ id, label, agents, installed, loaded, version, builtin, enabled, error, pending, remote, job })),
    };
  },
});

defineOp({
  name: 'modules.install', title: '从 GitHub 安装 / 更新一个功能扩展',
  desc: '下载与本机主程序同一次打包的离线包（本地发版目录里有就直接用），校验大小与 sha256 后排进待生效，等下载装完才返回。'
    + '装好后要重启服务端才生效（先问用户再重启）。先用 modules.list 看 remote.action 是不是 install / update，不是的话 reason 就是不能装的原因。',
  access: 'write', need: ['server.manage'], slow: true,
  params: { id: { type: 'string', required: true, enum: MODULE_CATALOG.map((m) => m.id), desc: '扩展 id' } },
  example: { id: 'vertex' },
  handler: async (ctx, args) => {
    try {
      const r = await installFromRelease(args.id);
      return { id: r.id, version: r.version, from: r.from, restartNeeded: true, hint: RESTART_HINT };
    } catch (e) {
      throw new OpError(CODE_OF[e?.status] || 'failed', String(e?.message || e));
    }
  },
});
