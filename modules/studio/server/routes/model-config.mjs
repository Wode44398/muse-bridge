// 模型配置层的接口（业务在 model-config/index.mjs）。身份、读 body、出错格式用 registerStudioApi 的那几个帮手。
//
//   GET  /api/studio/model-config?key=<服务>/<模型>   → { ok, config }   一个模型的配置视图（基础卡、生效卡、覆盖、配方、示例配方）
//   GET  /api/studio/model-config?provider=<服务 id>   → { ok, configs: { <模型 id>: { over?, recipe?, at } } }   哪些模型配过
//   POST /api/studio/model-config  { key, over?, recipe?, create? } → { ok, config, warnings }   over / recipe 给 null = 删掉
//   POST /api/studio/model-trial   { key, dry, prompt?, negative?, params?, inputs?, recipe?, over?, kind? }
//        dry:true  → { ok, dry, params, warnings, request|null, note? }   预演：只拼请求不发，不花钱
//        dry:false → { ok, job }   真跑一次（花钱，走任务表，不自动存进工作空间）；记录用下面这个取
//   GET  /api/studio/model-trial?job=<任务 id>         → { ok, job, trace: [{ step, method, url, request, response, ms, error? }], done }
// 写入推总线 { type: 'studio.catalog' }（目录版本号已变，前端重拉）。

import { busPublish } from '@bridge/core/runtime/bus.mjs';
import { configView, providerConfigs, writeConfig, trial, trialResult } from '../model-config/index.mjs';

export function registerModelConfigRoutes(router, { guard, body, run }) {
  router.on('GET', '/api/studio/model-config', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const pid = url.searchParams.get('provider');
    run(res, () => (pid ? { configs: providerConfigs(g.owner, pid) } : { config: configView(g.owner, url.searchParams.get('key')) }));
  });

  router.on('POST', '/api/studio/model-config', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res, 64 * 1024); if (!b) return;
    run(res, () => {
      const by = g.ctx.agentCaller ? 'agent' : 'user';
      const { view, warnings } = writeConfig(g.owner, b, { by });
      busPublish(g.owner, { type: 'studio.catalog' });
      return { config: view, warnings };
    });
  });

  router.on('POST', '/api/studio/model-trial', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res, 256 * 1024); if (!b) return;
    run(res, () => trial(g.ctx, g.owner, b));
  });

  router.on('GET', '/api/studio/model-trial', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    run(res, () => {
      const r = trialResult(g.owner, url.searchParams.get('job'));
      if (!r) throw Object.assign(new Error('找不到这次试跑（服务重启过，或不是你的）'), { status: 404 });
      return r;
    });
  });
}
