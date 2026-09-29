// 「工作空间里的一份（或一叠）文件/文件夹」在全域拖拽里的契约：拖源怎么描述自己、落点怎么接。
//
// 拖源（FilesPanel / FilesDesktop）造 payload 时把三件能力一并交出来：
//   moveInto(destRel)   —— 把整叠搬进【同一个文件系统作用域】里的某个目录（落点不关心细节），
//                          逐项进行、汇总成 { ok, moved, failed, error }
//   materials(direct)   —— 整叠变成「发给 AI」的素材数组（走 /api/files/to-upload 那条既有链路）
//   add(item)           —— 拖拽进行中再拎一份进来（iOS「点其他文件加进叠放」），同作用域且不重复才收
// 落点只按 type 与 ctx 判断能不能接，不去猜来源是谁。
//
// 为什么把「同源」判定放这儿：跨作用域的搬运没有单一原子接口，做成半成功的搬家比不给做更糟；
// 所以跨作用域默认不给「移动」，只给「发给 AI」。
// 例外：云端 ↔ 云端（工作台里以项目目录为根的面板 ↔ 整页工作空间根页）两边都是服务端自己的盘，
// /api/files/move 带 fromWs 一次搬完。
import { compose } from './state.svelte.js';
import { api } from './api.js';
import { cloudFileUrl } from './preview.svelte.js';
import { dropToast } from './dragdrop.svelte.js';
import { t, tr } from './i18n.js';

export const WS_FILE = 'ws-file';

// 作用域指纹：origin（cloud）+ 云端 ws 根 + 位置 id
export const fsKey = (c) => JSON.stringify([c?.origin || '', c?.ws || '', c?.locationId || '']);
export const sameFs = (a, b) => fsKey(a) === fsKey(b);

const parentOf = (rel) => (rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// 能不能把这一叠放进 destRel（同一作用域内的目录相对路径，'' = 根）：
//   · 必须同作用域   · 任何一份都不能放进自己或自己的子目录   · 全都已经在那儿了就没意义
// 云端 ↔ 云端但根不同＝跨作用域可搬（见文件头例外）；其余跨作用域一律不接。
export const crossCloud = (a, b) => !sameFs(a, b) && a?.origin === 'cloud' && b?.origin === 'cloud';

export function canMoveInto(payload, destCtx, destRel) {
  if (!payload || payload.type !== WS_FILE || !payload.moveInto) return false;
  const cross = !sameFs(payload.ctx, destCtx);
  if (cross && !crossCloud(payload.ctx, destCtx)) return false;
  const dest = destRel || '';
  let movable = 0;
  for (const it of payload.items || []) {
    const rel = it.rel || '';
    if (!rel) return false;
    if (cross) { movable++; continue; }   // 不同根：不存在「放进自己」「已在那儿」这两种情况
    if (dest === rel || dest.startsWith(rel + '/')) return false;
    if (parentOf(rel) !== dest) movable++;
  }
  return movable > 0;
}

// —— 落点①：某个文件夹 / 某一级面包屑 / 当前目录空白处 ——
// name 只用来写提示语（「移到 xxx」）；spring 给了就支持「悬停打开」。
export function folderDropZone({ key, name, ctx, rel, onDone, disabled = false, spring = null }) {
  return {
    key,
    effect: 'move',
    disabled,
    spring,
    // 没给 name 时中文仍是「移到「这里」」，英文说 Move here——所以有无 name 各一个键
    label: (p) => (p?.count > 1
      ? (name ? t('移 {n} 项到「{name}」', { n: p.count, name }) : t('移 {n} 项到「这里」', { n: p.count }))
      : (name ? t('移到「{name}」', { name }) : t('移到「这里」'))),
    accept: (p) => canMoveInto(p, ctx, rel),
    async drop(p) {
      dropToast(t('移动中…'));
      const r = await p.moveInto(rel, ctx);
      const where = name || t('目标文件夹');
      if (r?.ok) dropToast(r.moved > 1 ? t('已移 {n} 项到「{name}」', { n: r.moved, name: where }) : t('已移到「{name}」', { name: where }));
      else if (r?.moved) {
        const o = { n: r.moved, f: r.failed, name: where };
        dropToast(r.error ? t('{n} 项已移到「{name}」，{f} 项失败：{reason}', { ...o, reason: tr(r.error) }) : t('{n} 项已移到「{name}」，{f} 项失败', o));
      } else dropToast(r?.error ? t('移动失败：{reason}', { reason: tr(r.error) }) : t('移动失败'));
      if (r?.moved) onDone?.();
    },
  };
}

// —— 落点②：某个 agent 的对话（挂进它的输入栏）——
// 语义刻意不是「移动」而是「发送」：文件留在工作空间原地，只是这次对话多了一份附件。
const AGENT_LABEL = { claude: 'Claude' };

function pushAttachment(target, att) {
  if (target !== 'claude') return false;
  compose.attachments.push(att);
  return true;
}

export async function attachToAgent(payload, target) {
  if (!payload?.materials) return false;
  dropToast(t('正在准备…'));
  const atts = await payload.materials(true);
  const want = payload.count || 1;
  if (!atts?.length) { dropToast(t('准备失败')); return false; }
  let ok = 0;
  for (const att of atts) if (pushAttachment(target, att)) ok++;
  if (!ok) return false;
  const who = AGENT_LABEL[target] || t('对话');
  dropToast(ok < want ? t('{ok}/{n} 项已挂进 {agent} 的输入栏', { ok, n: want, agent: who }) : (ok > 1 ? t('已挂 {n} 项进 {agent} 的输入栏', { n: ok, agent: who }) : t('已挂进 {agent} 的输入栏', { agent: who })));
  return true;
}

export function agentDropZone(target, { key = 'chat:' + target, label = t('挂进这个对话'), disabled = false } = {}) {
  return {
    key,
    effect: 'send',
    // label 是调用方给的一整句动作（已按界面语言翻好）；英文把件数放括号里，避免拆动作短语
    label: (p) => (p?.count > 1 ? t('把 {n} 项{action}', { n: p.count, action: label }) : label),
    disabled,
    accept: (p) => p?.type === WS_FILE && !!p.materials,
    drop: (p) => attachToAgent(p, target),
  };
}

// —— 桌面（鼠标）那半边：HTML5 拖拽 ——
// 手指走的是上面那套 pointer 拖拽；鼠标在电脑版工作空间里走的是浏览器原生 HTML5 拖拽。
// 两套语义要一致，就让 HTML5 侧也带上同一份
// 描述符：拖进对话时按 rel 现场备素材，落点表现与手指那套完全一样。
export const WS_DT = 'application/x-bridge-ws';

export const dtHasWsFiles = (e) => Array.prototype.indexOf.call(e.dataTransfer?.types || [], WS_DT) !== -1;

// 只有 drop 事件读得到 getData（dragover 阶段浏览器出于隐私只给 types）。
export function wsDescriptorFrom(dt) {
  try {
    const d = JSON.parse(dt?.getData(WS_DT) || 'null');
    return Array.isArray(d?.rels) && d.rels.length ? d : null;
  } catch { return null; }
}

export async function attachDescriptorToAgent(desc, target) {
  if (!desc) return false;
  dropToast(t('正在准备…'));
  let ok = 0;
  for (const rel of desc.rels) {
    const name = String(rel).split('/').pop() || 'file';
    const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(name);
    try {
      const up = await api.fileToUpload(rel, false, desc.ws || '');
      const att = { path: up.path, name: up.name, kind: isImg ? 'image' : 'file', url: isImg ? cloudFileUrl(rel, { ws: desc.ws || '' }) : null };
      if (pushAttachment(target, att)) ok++;
    } catch {}
  }
  dropToast(ok ? t('已挂进 {agent} 的输入栏', { agent: AGENT_LABEL[target] || t('对话') }) : t('准备失败'));
  return ok > 0;
}

// 拖源造 payload 的统一入口——字段名固定下来，落点才不用认来源。
//   items      [{ rel, name, isDir, size, mtime }]，起拖那一刻的【快照】（拖到一半源页面可能已翻走/卸载）
//   moveOne    (item, destRel, destCtx?) → { ok, error }   单项搬运（destCtx 非空＝跨根，目标按它解析；
//              不要在里面刷新列表——整叠搬完统一 afterMove）
//   materialOne(item, direct) → att | null       单项备成素材
//   afterMove  () 整叠搬完后的对账（源面板还在的话刷新一下）
// 兼容字段 name/isDir/rel 指向第一份：落点的提示语/幽灵只看它。
export function wsFilePayload({ items, ctx, moveOne, materialOne, afterMove = null }) {
  const list = [...(items || [])];
  const has = (rel) => list.some((it) => it.rel === rel);
  const payload = {
    type: WS_FILE,
    ctx,
    items: list,
    get count() { return list.length; },
    get name() { return list[0]?.name || ''; },
    get isDir() { return !!list[0]?.isDir; },
    get rel() { return list[0]?.rel || ''; },
    get rels() { return list.map((it) => it.rel); },
    get dirs() { return list.map((it) => !!it.isDir); },
    add(item) {
      if (!item?.rel || has(item.rel)) return false;
      // 不许把某份的祖先/后代叠在一起搬：搬完一个另一个就不在原地了
      for (const it of list) if (item.rel.startsWith(it.rel + '/') || it.rel.startsWith(item.rel + '/')) return false;
      list.push(item);
      return true;
    },
    // destCtx：落点的作用域；与本叠不同根（云端 ↔ 云端）时原样交给 moveOne 做跨根搬运
    async moveInto(destRel, destCtx = null) {
      const dest = destRel || '';
      const cross = !!destCtx && !sameFs(ctx, destCtx);
      let moved = 0, failed = 0, error = '';
      for (const it of list) {
        if (!cross && parentOf(it.rel) === dest) continue;   // 已经在那儿
        let r = null;
        try { r = await moveOne(it, dest, cross ? destCtx : null); } catch (e) { r = { ok: false, error: e?.message || '' }; }
        if (r?.ok) moved++;
        else { failed++; error = error || r?.error || ''; }
      }
      try { await afterMove?.(); } catch {}
      return { ok: failed === 0 && moved > 0, moved, failed, error };
    },
    async materials(direct) {
      const out = [];
      for (const it of list) {
        try { const a = await materialOne(it, direct); if (a) out.push(a); } catch {}
      }
      return out;
    },
    material: (direct) => materialOne(list[0], direct),
    moveOne,
  };
  return payload;
}
