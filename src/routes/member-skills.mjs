// 成员自己的技能 REST 面（/api/my-extensions*）。形状对齐管理员的 /api/extensions*，前端同一个面板（Customize）
// 按身份切换接口前缀：成员看到的「扩展」页 = 只有技能、只有「我的 / 发现」、生效 agent 只有 Claude 与 dimensio。
//
// 门禁：已登录的注册用户（kind 'user'）。管理员有完整的扩展中心，这里对管理员回 403（避免两套入口管同一件事）；
// 分享 / 快照访客、未登录一律拒。数据全落在他自己的那份注册表里（member-skills.mjs），够不到别人的、也够不到管理员的。
// 写操作受 server.mjs 全局 Origin CSRF 闸保护；上传走 raw body（Buffer）。
import {
  listMemberSkills, getMemberSkill, installMemberSkill, installMemberSkillFromDir, updateMemberSkill, deleteMemberSkill,
  bulkMemberSkills, listMemberSkillFiles, readMemberSkillFile, memberSkillDir, memberInstalledKeys, MEMBER_SUPPORT,
} from '../member-skills.mjs';
import { packDirZip, listExtensions } from '../extensions.mjs';
import { marketIndex, marketInstall } from '../ext-market.mjs';
import { readBody } from '../runtime/body.mjs';

const MAX_UPLOAD = 32 * 1024 * 1024;

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => {
  const code = e?.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  json(res, code, { ok: false, error: String(e?.message || e) });
};

function readRawBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) { done = true; chunks.length = 0; reject(Object.assign(new Error('文件超出大小上限'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

const parse = async (req) => { try { return JSON.parse(await readBody(req)); } catch { return {}; } };

export function registerMemberSkillRoutes(router, { identify }) {
  // 返回账号 id；不放行时已写好响应
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'user' && id.user) return id.user;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: id?.kind === 'admin' ? '管理员请用扩展中心' : '请先登录' });
    return null;
  };

  // 列表：他自己的 + 管理员加装给全服的技能（只读，前端标「服务器统一提供」）
  router.on('GET', '/api/my-extensions', (req, res) => {
    const user = gate(req, res);
    if (!user) return;
    const shared = listExtensions({ scope: 'shared' })
      .filter((x) => x.type === 'skill' && x.enabled)
      .map((x) => ({ name: x.name, description: x.description || '', ...(x.pkg ? { pkg: x.pkg } : {}), agents: { claude: !!x.agents?.claude, dimensio: !!x.agents?.dimensio } }));
    json(res, 200, { ok: true, scope: 'member', items: listMemberSkills(user), support: MEMBER_SUPPORT, shared });
  });

  router.on('POST', '/api/my-extensions/upload', async (req, res, url) => {
    const user = gate(req, res);
    if (!user) return;
    try {
      if ((url.searchParams.get('type') || 'skill') !== 'skill') throw Object.assign(new Error('只能添加技能'), { status: 400 });
      const name = decodeURIComponent(url.searchParams.get('name') || 'upload.zip');
      const buf = await readRawBuffer(req, MAX_UPLOAD);
      if (!buf.length) throw Object.assign(new Error('空文件'), { status: 400 });
      const item = await installMemberSkill(user, name, buf, {
        replaceId: url.searchParams.get('replace') || undefined,
        pkg: url.searchParams.get('pkg') || undefined,
      });
      json(res, 200, { ok: true, item });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/my-extensions/update', async (req, res) => {
    const user = gate(req, res);
    if (!user) return;
    try { const input = await parse(req); json(res, 200, { ok: true, item: updateMemberSkill(user, input.id, input) }); }
    catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/my-extensions/delete', async (req, res) => {
    const user = gate(req, res);
    if (!user) return;
    try { const input = await parse(req); json(res, 200, { ok: !!deleteMemberSkill(user, input.id) }); }
    catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/my-extensions/bulk', async (req, res) => {
    const user = gate(req, res);
    if (!user) return;
    try { const input = await parse(req); json(res, 200, { ok: true, ...bulkMemberSkills(user, input.pkg, input) }); }
    catch (e) { fail(res, e); }
  });

  // 发现：同一份市场索引，只给技能（连接器 / 插件是主机级能力）；增删市场源仍只有管理员能做
  router.on('GET', '/api/my-extensions/market', (req, res, url) => {
    const user = gate(req, res);
    if (!user) return;
    try {
      const idx = marketIndex({ refresh: false });
      json(res, 200, { ok: true, ...idx, connectors: [], installed: memberInstalledKeys(user), skillsOnly: true });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/my-extensions/market/install', async (req, res) => {
    const user = gate(req, res);
    if (!user) return;
    try {
      const input = await parse(req);
      if (input.kind !== 'skill' && input.kind !== 'skillpack') throw Object.assign(new Error('只能添加技能'), { status: 400 });
      const r = await marketInstall({ kind: input.kind, key: input.key }, {
        installSkillFromDir: (dir, opts) => installMemberSkillFromDir(user, dir, opts),
      });
      json(res, 200, { ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  router.on('GET', '/api/my-extensions/files', (req, res, url) => {
    const user = gate(req, res);
    if (!user) return;
    json(res, 200, { ok: true, files: listMemberSkillFiles(user, url.searchParams.get('id')) });
  });

  router.on('GET', '/api/my-extensions/file', (req, res, url) => {
    const user = gate(req, res);
    if (!user) return;
    try { json(res, 200, { ok: true, text: readMemberSkillFile(user, url.searchParams.get('id'), url.searchParams.get('path')) }); }
    catch (e) { fail(res, e); }
  });

  router.on('GET', '/api/my-extensions/download', async (req, res, url) => {
    const user = gate(req, res);
    if (!user) return;
    try {
      const id = url.searchParams.get('id');
      const item = getMemberSkill(user, id);
      const dir = item && memberSkillDir(user, id);
      if (!dir) throw Object.assign(new Error('技能不存在'), { status: 404 });
      const buf = await packDirZip(dir);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}.zip`,
      });
      res.end(buf);
    } catch (e) { fail(res, e); }
  });
}
