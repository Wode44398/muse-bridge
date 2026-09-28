// 扩展中心 REST 面（设置 → 个性化 → 扩展）。三端同一套 API：手机/网页经隧道、
// 桌面壳打本机 loopback——扩展落在【当前 bridge 实例】的 DATA_ROOT/extensions/，
// 客户端形态即本机、服务端/附着形态即主机，天然分流无需两套代码。
//
// 门禁：全部 admin（token/cookie，可远程——管理员在手机上也能传技能），非 admin 一律 403。
// 装/删/启停会改所有 admin 会话的 agent 行为，属主机级能力，不下放 Pro/普通 user。
// 写操作受 server.mjs 全局 Origin CSRF 闸保护；上传走 raw body（Buffer），不引 multipart。
import {
  listExtensions, getExtension, installSkill, installPlugin, saveConnector,
  updateExtension, deleteExtension, bulkByPkg, listExtensionFiles, readExtensionFile,
  packExtensionZip, extensionDiagnostics, EXT_SUPPORT,
} from '../extensions.mjs';
import { readBody } from '../runtime/body.mjs';

const MAX_UPLOAD = 64 * 1024 * 1024;   // 技能/插件包上限 64MB（一般几百 KB）

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => {
  const code = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  json(res, code, { ok: false, error: String(e?.message || e) });
};

// raw body → Buffer（readBody 是字符串通道，二进制包必须走这里）。
function readRawBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        chunks.length = 0;
        reject(Object.assign(new Error('文件超出大小上限'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export function registerExtensionRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: '扩展管理仅对管理员开放' });
    return false;
  };

  // 列表 + 支持矩阵（前端据此渲染勾选可用性，避免两处硬编码漂移）+ 诊断（G10：注册表坏了、凭据解不开、
  // 技能目录没了，都要看得见）。连接器凭据只给键名、值打码（S3）。
  router.on('GET', '/api/extensions', (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, { ok: true, items: listExtensions(), support: EXT_SUPPORT, diagnostics: extensionDiagnostics() });
  });

  // 上传技能/插件：?type=skill|plugin&name=<原始文件名>&replace=<替换的扩展id>&pkg=<所属包名>
  router.on('POST', '/api/extensions/upload', async (req, res, url) => {
    if (!gate(req, res)) return;
    try {
      const type = url.searchParams.get('type') || 'skill';
      const name = decodeURIComponent(url.searchParams.get('name') || 'upload.zip');
      const replaceId = url.searchParams.get('replace') || undefined;
      const pkg = url.searchParams.get('pkg') || undefined;
      const buf = await readRawBuffer(req, MAX_UPLOAD);
      if (!buf.length) throw Object.assign(new Error('空文件'), { status: 400 });
      const item = type === 'plugin'
        ? await installPlugin(name, buf, { replaceId, pkg })
        : await installSkill(name, buf, { replaceId, pkg });
      json(res, 200, { ok: true, item });
    } catch (e) { fail(res, e); }
  });

  // 新建/编辑连接器（JSON 表单；带 id 即编辑）。
  router.on('POST', '/api/extensions/connector', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      let input; try { input = JSON.parse(await readBody(req)); } catch { input = {}; }
      json(res, 200, { ok: true, item: saveConnector(input) });
    } catch (e) { fail(res, e); }
  });

  // 开关 / agent 勾选矩阵。
  router.on('POST', '/api/extensions/update', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      let input; try { input = JSON.parse(await readBody(req)); } catch { input = {}; }
      json(res, 200, { ok: true, item: updateExtension(input.id, input) });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/extensions/delete', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      let input; try { input = JSON.parse(await readBody(req)); } catch { input = {}; }
      json(res, 200, { ok: !!deleteExtension(input.id) });
    } catch (e) { fail(res, e); }
  });

  // 包级批量：{ pkg, action: enable|disable|agents|delete, agents? }——散装项（无 pkg）够不到此接口。
  router.on('POST', '/api/extensions/bulk', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      let input; try { input = JSON.parse(await readBody(req)); } catch { input = {}; }
      json(res, 200, { ok: true, ...bulkByPkg(input.pkg, input) });
    } catch (e) { fail(res, e); }
  });

  // 详情页文件树 / 单文件预览（严格锁扩展目录内，extensions.mjs 里做穿越校验）。
  router.on('GET', '/api/extensions/files', (req, res, url) => {
    if (!gate(req, res)) return;
    json(res, 200, { ok: true, files: listExtensionFiles(url.searchParams.get('id')) });
  });

  router.on('GET', '/api/extensions/file', (req, res, url) => {
    if (!gate(req, res)) return;
    try {
      const text = readExtensionFile(url.searchParams.get('id'), url.searchParams.get('path'));
      json(res, 200, { ok: true, text });
    } catch (e) { fail(res, e); }
  });

  // 下载为 zip（前端 fetch+blob 取，带 Authorization/cookie，不走 ?token=）。
  router.on('GET', '/api/extensions/download', async (req, res, url) => {
    if (!gate(req, res)) return;
    try {
      const item = getExtension(url.searchParams.get('id'));
      if (!item) throw Object.assign(new Error('扩展不存在'), { status: 404 });
      const buf = await packExtensionZip(item);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}.zip`,
      });
      res.end(buf);
    } catch (e) { fail(res, e); }
  });
}
