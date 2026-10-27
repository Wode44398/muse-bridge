// 工作空间文件：列目录、读、写、搜、建文件夹、移动 / 改名 / 复制、删除。
// 路径一律相对调用者的工作空间根（主机 = 工作区，成员 = 自己的文件夹）；越界、系统目录由现成路由挡。
// 主机（及有命令行的身份）可用 ws 指定另一个根（某个项目目录的绝对路径），与工作台同一套授权。

import path from 'node:path';
import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { searchWorkspace } from '../../routes/file-core.mjs';
import { safeJoin } from '../../runtime/http-file.mjs';
import { authorizeProjectPath } from '../../project-paths.mjs';

defineGroup('files', '文件', '调用者工作空间里的文件（路径相对工作空间根）。');

const WS = { type: 'string', desc: '可选：换一个根目录（绝对路径，须是你有权访问的项目目录；只给有命令行的身份）' };
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php|graphql))/i;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'xml', 'svg', 'yml', 'yaml', 'py', 'rb', 'go', 'rs', 'sh', 'bat', 'ps1', 'ini', 'toml', 'conf', 'env', 'sql', 'vue', 'svelte', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'swift', 'php', 'lua', 'r', 'tex', 'rst', 'gitignore', '']);
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const withWs = (args, body) => (args.ws ? { ...body, ws: args.ws } : body);
const splitPath = (p) => { const n = norm(p); const i = n.lastIndexOf('/'); return i < 0 ? ['', n] : [n.slice(0, i), n.slice(i + 1)]; };

function fail(r, what) {
  const msg = routeError(r);
  if (r.status === 404) throw new OpError('not_found', what + '：不存在');
  if (r.status === 403) throw new OpError('forbidden', what + '：没有权限（越界、系统目录，或需要命令行权限）');
  if (r.status === 409) throw new OpError('conflict', what + '：目标已存在');
  if (r.status === 413) throw new OpError('bad_args', what + '：内容太大');
  if (r.status === 415) throw new OpError('bad_args', what + '：只能写文本类文件（.md .txt .json 代码等）');
  if (r.status === 400) throw new OpError('bad_args', what + '：' + msg);
  throw new OpError('failed', what + '：' + msg);
}

function rootOf(ctx, ws) {
  if (!ws) return ctx.cwd;
  if (!ctx.shell) throw new OpError('forbidden', 'ws 只给有命令行的身份');
  try { return authorizeProjectPath(ctx, ws); }
  catch (e) { throw new OpError('forbidden', e?.message || '这个目录不在你的授权范围'); }
}

defineOp({
  name: 'files.list', title: '列目录',
  desc: '列出一个文件夹的内容（文件夹在前）。path 留空 = 工作空间根。q 按名字筛（只筛这一层，不递归；递归找用 files.search）。',
  params: {
    path: { type: 'string', default: '', desc: '相对工作空间根的文件夹路径' },
    q: { type: 'string', desc: '按名字筛（子串，不分大小写）' },
    ws: WS,
  },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'GET', '/api/files?' + qs({ path: norm(args.path), q: args.q, ws: args.ws }));
    if (r.status !== 200 || !r.json || r.json.error) fail(r.json?.error ? { ...r, status: 403 } : r, '列目录');
    return {
      path: r.json.path || '',
      items: (r.json.items || []).map((i) => ({ name: i.name, type: i.isDir ? 'folder' : 'file', ...(i.isDir ? {} : { size: i.size }), modifiedAt: Math.round(i.mtime || 0) })),
      ...(r.json.truncated ? { truncated: true, total: r.json.total } : {}),
    };
  },
});

defineOp({
  name: 'files.read', title: '读文件',
  desc: '文本类文件返回 content（UTF-8，超过 maxBytes 截断并标 truncated）；图片、视频、压缩包等二进制只返回大小、类型和下载地址（HTTP 调用方带同一个 Authorization 头 GET 它）。',
  params: {
    path: { type: 'string', required: true, desc: '相对工作空间根的文件路径' },
    maxBytes: { type: 'integer', min: 1, max: 2_000_000, default: 200_000, desc: '最多读多少字节' },
    ws: WS,
  },
  handler: async (ctx, args, env) => {
    const rel = norm(args.path);
    if (!rel) throw new OpError('bad_args', '缺少文件路径');
    const query = qs({ path: rel, ws: args.ws });
    const r = await internalRequest(env.identity, 'GET', '/api/file?' + query, null, { maxBytes: args.maxBytes + 1, timeoutMs: 60_000 });
    if (r.status !== 200 && r.status !== 206) fail(r, '读文件');
    const mime = String(r.headers['content-type'] || '').split(';')[0].trim();
    const ext = path.extname(rel).slice(1).toLowerCase();
    const size = Number(r.headers['content-length']) || r.res.size;
    const downloadUrl = (env.origin || '') + '/api/file?' + query;
    if (!(TEXT_MIME.test(mime) || TEXT_EXT.has(ext))) return { path: rel, binary: true, mime, size, downloadUrl };
    let buf = r.res.body();
    const truncated = r.overflow || buf.length > args.maxBytes;
    if (buf.length > args.maxBytes) buf = buf.subarray(0, args.maxBytes);
    return { path: rel, content: buf.toString('utf8'), size, ...(truncated ? { truncated: true, note: `只读了前 ${args.maxBytes} 字节；调大 maxBytes 或下载 downloadUrl` } : {}) };
  },
});

defineOp({
  name: 'files.write', title: '写文件',
  desc: '写一个文本类文件（.md .txt .json .csv 代码等，≤5MB）。默认只新建：同名已存在报 conflict；overwrite=true 才覆盖。上级文件夹要先存在（用 files.mkdir 建）。',
  access: 'write',
  params: {
    path: { type: 'string', required: true, desc: '相对工作空间根的文件路径（含文件名与扩展名）' },
    content: { type: 'string', required: true, max: 5_000_000 },
    overwrite: { type: 'boolean', default: false },
    ws: WS,
  },
  handler: async (ctx, args, env) => {
    const [dir, name] = splitPath(args.path);
    if (!name) throw new OpError('bad_args', '缺少文件名');
    const r = await internalRequest(env.identity, 'POST', '/api/files/newfile', withWs(args, { path: dir, name, content: args.content }));
    if (r.status === 200) return { path: norm(args.path), created: true };
    if (r.status === 409 && args.overwrite) {
      const s = await internalRequest(env.identity, 'POST', '/api/file/save', withWs(args, { path: norm(args.path), content: args.content }));
      if (s.status === 200) return { path: norm(args.path), overwritten: true };
      fail(s, '覆盖文件');
    }
    if (r.status === 409) throw new OpError('conflict', '文件已存在', { hint: '要覆盖就传 overwrite=true' });
    fail(r, '写文件');
  },
});

defineOp({
  name: 'files.search', title: '按名字找文件',
  desc: '在一个文件夹及其子文件夹里按文件 / 文件夹名找（子串，不分大小写；跳过 node_modules、.git）。只按名字，不搜内容。',
  params: {
    q: { type: 'string', required: true, max: 200 },
    path: { type: 'string', default: '', desc: '从哪个文件夹开始找（默认工作空间根）' },
    limit: { type: 'integer', min: 1, max: 200, default: 50 },
    ws: WS,
  },
  handler: async (ctx, args) => {
    const root = rootOf(ctx, args.ws);
    const start = safeJoin(root, norm(args.path));
    if (!start) throw new OpError('forbidden', '路径越界');
    const r = await searchWorkspace(start, args.q, { maxResults: args.limit });
    const prefix = norm(args.path);
    return {
      matches: r.matches.filter((m) => !m.path.split('/').includes('.bridge') || ctx.kind === 'admin').map((m) => ({ path: prefix ? prefix + '/' + m.path : m.path, type: m.isDir ? 'folder' : 'file' })),
      ...(r.truncated ? { truncated: true } : {}),
    };
  },
});

defineOp({
  name: 'files.mkdir', title: '建文件夹',
  access: 'write',
  params: { path: { type: 'string', required: true, desc: '要建的文件夹路径（上级要已存在）' }, ws: WS },
  handler: async (ctx, args, env) => {
    const [dir, name] = splitPath(args.path);
    if (!name) throw new OpError('bad_args', '缺少文件夹名');
    const r = await internalRequest(env.identity, 'POST', '/api/files/mkdir', withWs(args, { path: dir, name }));
    if (r.status !== 200) fail(r, '建文件夹');
    return { path: norm(args.path), created: true };
  },
});

defineOp({
  name: 'files.move', title: '移动到另一个文件夹',
  desc: '把文件或文件夹移进 toFolder（名字不变；目标里有同名的会自动加序号）。只改名用 files.rename。',
  access: 'write',
  params: { path: { type: 'string', required: true }, toFolder: { type: 'string', required: true, desc: '目标文件夹（相对工作空间根，空串 = 根）' }, ws: WS },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/files/move', withWs(args, { path: norm(args.path), dest: norm(args.toFolder) }));
    if (r.status !== 200) fail(r, '移动');
    const name = r.json?.name || path.basename(norm(args.path));
    return { from: norm(args.path), to: (norm(args.toFolder) ? norm(args.toFolder) + '/' : '') + name };
  },
});

defineOp({
  name: 'files.copy', title: '复制到另一个文件夹',
  access: 'write',
  params: { path: { type: 'string', required: true }, toFolder: { type: 'string', required: true }, ws: WS },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/files/copy', withWs(args, { path: norm(args.path), dest: norm(args.toFolder) }), { timeoutMs: 300_000 });
    if (r.status !== 200) fail(r, '复制');
    const name = r.json?.name || path.basename(norm(args.path));
    return { from: norm(args.path), to: (norm(args.toFolder) ? norm(args.toFolder) + '/' : '') + name };
  },
});

defineOp({
  name: 'files.rename', title: '改名',
  access: 'write',
  params: { path: { type: 'string', required: true }, name: { type: 'string', required: true, max: 255, desc: '新名字（只是名字，不含路径）' }, ws: WS },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/files/rename', withWs(args, { path: norm(args.path), name: args.name }));
    if (r.status !== 200) fail(r, '改名');
    const [dir] = splitPath(args.path);
    return { from: norm(args.path), to: (dir ? dir + '/' : '') + (r.json?.name || args.name) };
  },
});

defineOp({
  name: 'files.delete', title: '删除文件或文件夹',
  desc: '服务端跑在 Windows 上时，主机身份删的东西送进那台电脑的回收站（能在电脑上还原）；Linux / Docker 服务端没有回收站，成员也一样，都是永久删除、找不回来。返回的 recoverable 说明这次能不能恢复。删之前先征得用户同意。',
  access: 'danger',
  params: { path: { type: 'string', required: true }, ws: WS },
  handler: async (ctx, args, env) => {
    const rel = norm(args.path);
    if (!rel) throw new OpError('bad_args', '不能删工作空间根');
    // 回收站只有 Windows 有实现（runtime/recycle.mjs），而且只收主机身份的文件；其余一律永久删除
    const trash = ctx.kind === 'admin' && process.platform === 'win32';
    const r = await internalRequest(env.identity, 'POST', '/api/files/delete', withWs(args, trash ? { paths: [rel], trash: true } : { path: rel }), { timeoutMs: 120_000 });
    if (r.status !== 200 || (r.json && r.json.ok === false)) {
      if (r.json?.error) throw new OpError(r.status === 403 ? 'forbidden' : 'failed', '删除：' + r.json.error);
      fail(r, '删除');
    }
    return { path: rel, deleted: true, recoverable: trash };
  },
});
