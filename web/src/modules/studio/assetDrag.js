// 作品当拖源（侧栏作品流的行、画布上的结果）：桌面鼠标按下挪 4px 起拖，触屏按住 420ms 起拖；
// 起拖之后吞掉随后那一下 click（否则松手又「打开」了一次）。原地按住再松手交给 onStay（弹菜单）。
//   <div use:assetDrag={{ asset, onStay }}>
import { beginDrag, makeHold } from '../../lib/dragdrop.svelte.js';
import { t } from '../../lib/i18n.js';
import { assetPayload } from './drag.js';
import { mediaSrc } from './media.svelte.js';
import { visual } from './kinds.js';

export function ghostName(asset) {
  const p = String(asset?.prompt || '').replace(/\s+/g, ' ').trim();
  if (!p) return t('作品');
  const cs = [...p];
  return cs.length > 18 ? cs.slice(0, 17).join('') + '…' : p;
}

export function assetDrag(node, opts) {
  let o = opts || {};
  const hold = makeHold();
  let from = null, fired = false;
  // 拖影上的名字只取提示词开头一小段：整句提示词把拖影撑得比窗口还宽、盖住落点（复核 11-06）
  const ghost = () => ({ name: ghostName(o.asset), thumb: visual(o.asset?.kind) ? mediaSrc(o.asset, 'thumb') : '' });
  function down(e) {
    if (!o.asset || e.button !== 0 || e.target.closest?.('[data-nodrag]')) return;
    fired = false;
    if (e.pointerType === 'mouse') { from = { x: e.clientX, y: e.clientY, id: e.pointerId }; return; }
    hold.arm(e, (f) => {
      fired = true;
      beginDrag(assetPayload(o.asset), { x: f.x, y: f.y, pointerId: f.pointerId, pointerType: f.pointerType, sourceEl: node, ghost: ghost(), onStay: o.onStay ? () => o.onStay(node) : null });
    });
  }
  function move(e) {
    hold.track(e);
    if (from && e.pointerId === from.id && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) {
      from = null; fired = true;
      beginDrag(assetPayload(o.asset), { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: 'mouse', sourceEl: node, ghost: ghost() });
    }
  }
  function up() { hold.disarm(); from = null; }
  function click(e) { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('click', click, true);
  return {
    update(n) { o = n || {}; },
    destroy() {
      hold.disarm();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('click', click, true);
    },
  };
}
