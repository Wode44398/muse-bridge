// /api/modules* —— 扩展中心「功能扩展」（Vertex / Codex / dimensio 离线包）。仅管理员。
//
//   GET  /api/modules[?refresh=1]          三个扩展的状态（装没装 / 版本 / 来源 / 待生效改动 / 开没开）+ 主程序打包号，
//                                          每项带 remote（能不能从 GitHub 装 / 可更新到哪版 / 为什么不能）与 job（正在装的进度）；
//                                          第一次要问 GitHub 时最多等几秒，没问完先回 checking。refresh=1 不看缓存重问
//   POST /api/modules/install {id}         从这一版的发版（本地清单或 GitHub Release）下载、校验、排进待生效；进度经总线
//                                          modules.job 推。2 秒内装完（或一开始就不能装）直接回结果，否则回 started 后台接着装
//   POST /api/modules/upload?name=x.zip    原始 body = 离线包；边收边落盘（Codex 包好几百 MB，不进内存），排进待生效
//   POST /api/modules/uninstall {id}       排一个待卸载
//   POST /api/modules/cancel {id}          撤销还没生效的安装 / 卸载
// 装、换、卸都在下次重启时生效（见 modules/manage.mjs）；重启沿用现成的通道（桌面壳 runtime.restart /
// 控制台的 /api/admin/service/restart），这里不另造。

import crypto from 'node:crypto';
import path from 'node:path';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readBody } from '../runtime/body.mjs';
import { STAGING_DIR } from '../modules/registry.mjs';
import { installModuleArchive, uninstallModule, cancelPending } from '../modules/manage.mjs';
import { modulesOverviewRemote, modulesOverviewNow, installFromRelease } from '../modules/remote.mjs';

const MAX_PACKAGE = 3 * 1024 * 1024 * 1024;   // 3GB：Codex 离线包解压前几百 MB，留足余量

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => {
  const code = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  json(res, code, { ok: false, error: String(e?.message || e) });
};

// 请求体流式写进临时文件，超上限即断。
async function receiveToFile(req, file, maxBytes) {
  let total = 0;
  const limiter = async function* (source) {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw Object.assign(new Error('离线包超出大小上限'), { status: 413 });
      yield chunk;
    }
  };
  await pipeline(req, limiter, createWriteStream(file));
  return total;
}

export function registerModuleAdminRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: '功能扩展管理仅对管理员开放' });
    return false;
  };
  const jsonBody = async (req) => { try { return JSON.parse(await readBody(req)) || {}; } catch { return {}; } };

  router.on('GET', '/api/modules', async (req, res, url) => {
    if (!gate(req, res)) return;
    try { json(res, 200, await modulesOverviewRemote({ refresh: url.searchParams.get('refresh') === '1', waitMs: 6000 })); }
    catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/modules/install', async (req, res) => {
    if (!gate(req, res)) return;
    const id = String((await jsonBody(req)).id || '');
    const job = installFromRelease(id);
    let timer;
    const quick = await Promise.race([
      job.then((r) => ({ r }), (e) => ({ e })),
      new Promise((r) => { timer = setTimeout(() => r(null), 2000); }),
    ]);
    clearTimeout(timer);
    if (!quick) { job.catch(() => {}); return json(res, 200, { ok: true, id, started: true, overview: modulesOverviewNow() }); }
    if (quick.e) return fail(res, quick.e);
    json(res, 200, { ...quick.r, overview: modulesOverviewNow() });
  });

  router.on('POST', '/api/modules/upload', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = String(url.searchParams.get('name') || '');
    if (name && !/\.zip$/i.test(name)) return json(res, 400, { ok: false, error: '离线包是 .zip 文件' });
    mkdirSync(STAGING_DIR, { recursive: true });
    const tmp = path.join(STAGING_DIR, 'up-' + crypto.randomBytes(5).toString('hex') + '.zip');
    try {
      const size = await receiveToFile(req, tmp, MAX_PACKAGE);
      if (!size) throw Object.assign(new Error('没收到文件'), { status: 400 });
      const r = await installModuleArchive(tmp);
      json(res, 200, { ...r, overview: modulesOverviewNow() });
    } catch (e) {
      fail(res, e);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  router.on('POST', '/api/modules/uninstall', async (req, res) => {
    if (!gate(req, res)) return;
    try { json(res, 200, { ...uninstallModule(String((await jsonBody(req)).id || '')), overview: modulesOverviewNow() }); }
    catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/modules/cancel', async (req, res) => {
    if (!gate(req, res)) return;
    try { json(res, 200, { ...cancelPending(String((await jsonBody(req)).id || '')), overview: modulesOverviewNow() }); }
    catch (e) { fail(res, e); }
  });
}
