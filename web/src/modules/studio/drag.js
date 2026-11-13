// 拖进创作页：作品卡（Studio 自己的载荷）与工作空间文件（全域拖放的 WS_FILE / 桌面 HTML5 描述符）
// 落到输入岛的角色槽上。判断「这一份能当什么」「这一页此刻接不接」都在这里，界面只渲染结果。
import { WS_FILE } from '../../lib/fileDrag.js';
import { cloudFileUrl } from '../../lib/preview.svelte.js';
import { authHeaders } from '../../lib/api.js';
import { apiUrl } from '../../lib/server.js';
import { nativeLocLocalOnly } from '../../lib/nativeDesktop.js';
import { dropToast } from '../../lib/dragdrop.svelte.js';
import { t } from '../../lib/i18n.js';
import { studio, addInput, roleOk, mediaSrc } from './media.svelte.js';
import { fileKind, uploadRel } from './kinds.js';

export const STUDIO_ASSET = 'studio-asset';

/** 作品卡起拖时的载荷 */
export function assetPayload(a) {
  return { type: STUDIO_ASSET, asset: a, count: 1, get name() { return a.prompt || ''; } };
}

// 每页的槽（顺序即托盘上的顺序）；text＝把文本文件读进输入岛
// 视频页的 video / audio 槽只在当前模型收它们时才摆出来（Seedance 这类，§9.3 inputs.video / audio），见 DropTray
export const SLOTS = {
  image: ['edit', 'ref', 'text'],
  video: ['first', 'last', 'ref', 'video', 'audio', 'text'],
  voice: ['text', 'audio'],
  music: ['text', 'audio'],
};
export const OPTIONAL_SLOTS = { video: ['video', 'audio'] };
const ROLE_ACCEPTS = { edit: 'image', ref: 'image', first: 'image', last: 'image', audio: 'audio', video: 'video', text: 'text' };
/** 角色收的素材类别（image / video / audio / text） */
export const roleAccepts = (role) => ROLE_ACCEPTS[role] || 'image';

/** 载荷里第一份是什么：image / video / audio / text / null（文件夹、认不出的格式） */
export function payloadKind(p) {
  if (!p) return null;
  if (p.type === STUDIO_ASSET) {
    const k = p.asset?.kind;
    return k === 'music' ? 'audio' : k || null;
  }
  if (p.type === WS_FILE) {
    const it = p.items?.[0];
    return it && !it.isDir ? fileKind(it.name) : null;
  }
  if (p.type === 'ws-desc') return p.dirs?.[0] ? null : fileKind(p.rels?.[0] || '');
  if (p.type === 'os-file') return p.file?.type?.startsWith('image/') ? 'image' : p.file?.type?.startsWith('audio/') ? 'audio' : p.file?.type?.startsWith('video/') ? 'video' : fileKind(p.file?.name);
  return null;
}

/**
 * 某个槽此刻的状态：{ ok, reason, label }
 * reason：kind（拖的东西不对）| model（当前模型不收）| full | refMix | frameMix
 */
export function slotState(page, role, payload) {
  const pk = payloadKind(payload);
  const want = ROLE_ACCEPTS[role];
  if (!pk || pk !== want) return { ok: false, reason: 'kind' };
  if (role === 'text') return { ok: true };
  return roleOk(page, role);
}

/** 不指定角色时（松在输入岛本体 / 分段上）挑第一个能放的 */
export function defaultRole(page, payload) {
  const pk = payloadKind(payload);
  if (!pk) return null;
  const order = {
    image: ['edit', 'ref'],
    video: [...(studio.drafts.video.inputs.some((x) => x.role === 'first') ? ['last', 'ref', 'first'] : ['first', 'ref', 'last']), 'video', 'audio'],
    voice: ['audio'], music: ['audio'],
  }[page] || [];
  if (pk === 'text') return 'text';
  return order.find((r) => slotState(page, r, payload).ok) || null;
}

/** 返回执行这次落下的函数（能放才有）；role 为空＝默认角色 */
export function slotDropFor(page, payload, role) {
  const r = role || defaultRole(page, payload);
  if (!r || !slotState(page, r, payload).ok) return null;
  return () => dropInto(page, r, payload);
}

async function readText(rel, ws) {
  try {
    const res = await fetch(cloudFileUrl(rel, { ws, http: true }), { headers: authHeaders(), credentials: 'same-origin' });
    return res.ok ? (await res.text()).slice(0, 30000) : null;
  } catch { return null; }
}

/** 把一份载荷按角色挂进这一页的输入岛 */
export async function dropInto(page, role, payload) {
  studio.page = page;
  const d = studio.drafts[page];
  if (payload.type === STUDIO_ASSET) {
    const a = payload.asset;
    const kind = roleAccepts(role) === 'text' ? 'image' : roleAccepts(role);
    addInput(page, { role, asset: a.id, url: kind === 'audio' ? '' : mediaSrc(a, 'thumb'), name: a.prompt || '', kind, fromAsset: a.id });
    if (!d.parent) d.parent = { id: a.id, kind: a.kind, thumb: a.kind === 'image' || a.kind === 'video' ? mediaSrc(a, 'thumb') : '', prompt: a.prompt || '' };
    return true;
  }
  // 工作空间文件：身份工作空间根里的走 path（零拷贝、过路径守卫）；别的作用域先备成 uploads 素材
  const files = payload.type === WS_FILE
    ? (payload.items || []).map((it) => ({ rel: it.rel, name: it.name, ws: payload.ctx?.ws || '', origin: payload.ctx?.origin || 'cloud', loc: payload.ctx?.locationId || '' }))
    : payload.type === 'ws-desc'
      ? (payload.rels || []).map((rel) => ({ rel, name: String(rel).split('/').pop(), ws: payload.ws || '', origin: 'cloud', loc: payload.locationId || '' }))
      : [];
  if (payload.type === 'os-file') return dropOsFile(page, role, payload.file);
  const f = files[0];
  if (!f) return false;
  if (role === 'text') {
    const txt = f.origin === 'cloud' && !nativeLocLocalOnly(f.loc) ? await readText(f.rel, f.ws) : null;
    if (txt == null) { dropToast(t('读取失败')); return false; }
    studio.pendingText = { page, text: txt };
    return true;
  }
  const kind = roleAccepts(role);
  const direct = f.origin === 'cloud' && !f.ws && !nativeLocLocalOnly(f.loc);
  if (direct) {
    addInput(page, { role, path: f.rel, url: kind === 'image' ? cloudFileUrl(f.rel, { thumb: true }) : '', name: f.name, kind });
    return true;
  }
  if (payload.materials) {
    const live = addInput(page, { role, url: '', name: f.name, kind, pending: true });
    const mats = await payload.materials(false).catch(() => null);
    const m = mats?.[0];
    if (!m?.path) { d.inputs = d.inputs.filter((x) => x.id !== live.id); dropToast(t('准备失败')); return false; }
    live.upload = uploadRel(m.path); live.url = m.url || live.url; live.pending = false;
    return true;
  }
  dropToast(t('这个位置的文件要先放进工作空间'));
  return false;
}

/** 本机文件（拖进 / 粘贴 / 系统选择器）：先上传进 uploads */
export async function dropOsFile(page, role, file) {
  const { api } = await import('../../lib/api.js');
  const kind = roleAccepts(role);
  const cap = kind === 'video' ? 100_000_000 : 20_000_000;
  if (file.size > cap) { dropToast(kind === 'video' ? t('文件超过 100MB') : t('文件超过 20MB')); return false; }
  const live = addInput(page, { role, url: kind === 'image' ? URL.createObjectURL(file) : '', name: file.name, kind, pending: true });
  try {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
    const r = await api.upload(file.name, b64);
    const d = studio.drafts[page];
    const cur = d.inputs.find((x) => x.id === live.id);
    if (cur) { cur.upload = uploadRel(r.path); cur.pending = false; }
    return true;
  } catch {
    const d = studio.drafts[page];
    d.inputs = d.inputs.filter((x) => x.id !== live.id);
    dropToast(t('上传失败：{name}', { name: file.name }));
    return false;
  }
}
