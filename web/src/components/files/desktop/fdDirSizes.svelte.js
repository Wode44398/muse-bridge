// 工作空间 · 桌面版（FilesDesktop）的文件夹大小：壳主进程后台递归统计，算完一个推一个；老壳 / 网页没有这座桥就保持「—」。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { onMount, untrack } from 'svelte';
import { hasNativeDirSizes, nativeWorkspaceDirSizes, onNativeDirSize } from '../../../lib/nativeDesktop.js';
import { locale, t } from '../../../lib/i18n.js';
import { fmtSize } from '../../../lib/files/common.js';

export function createFdDirSizes(P) {
  // —— 文件夹大小（壳主进程后台递归统计，算完一个推一个；老壳/网页没有这座桥 → 保持「—」）——
  // 键 = scope|rel：scope 区分授权位置与云端根，切位置时旧作业的尾包记在它自己名下、不串台。
  // 重算期间旧值继续显示（文件一变整列闪「…」太吵），新的最终值到了直接覆盖。
  const canDirSize = $derived(hasNativeDirSizes() && (P.nativeFs || P.wsRootLocal));
  const dsScope = $derived(P.nativeFs ? 'loc:' + P.locationId : 'ws:' + P.wsRoot);
  const dsClient = 'fd-' + Math.random().toString(36).slice(2, 10);   // 同一窗口里可能同时挂着好几个工作空间面板
  let dirSizes = $state({});
  const dirSizeOf = (it) => (it?.isDir && !it.linkType ? dirSizes[dsScope + '|' + it.rel] : undefined);
  let dsBump = $state(0);
  let dsSent = '';
  let dsFresh = false;                  // 下一轮全部重算（F5）
  let dsStale = { items: new Set(), dirs: new Set() };
  function requestDirSizes({ fresh = false } = {}) {
    if (fresh) dsFresh = true;
    dsBump++;
  }
  // 云端作用域没有文件 watcher，面板自己动过什么自己报：items＝被移走/删掉的项本身（连子树带上级
  // 作废），dirs＝收进了东西的目标文件夹（只作废它和上级，里面没动的子树继续用缓存）。
  function sizesTouched(items = [], dirs = []) {
    if (P.nativeFs || !canDirSize) return;
    for (const rel of items) dsStale.items.add(rel);
    for (const rel of dirs) dsStale.dirs.add(rel);
    dsBump++;
  }
  let dsSoonTimer = 0, dsSoonFirst = 0;
  // 文件变化后稍等再重问：主进程已按变化路径把祖先的缓存作废，未变的子树秒回。持续写入时
  // 尾随防抖会一直推迟，最多憋 4 秒也发一次。
  function requestDirSizesSoon() {
    const now = Date.now();
    if (!dsSoonTimer) dsSoonFirst = now;
    clearTimeout(dsSoonTimer);
    dsSoonTimer = setTimeout(() => { dsSoonTimer = 0; requestDirSizes(); }, now - dsSoonFirst > 4000 ? 0 : 800);
  }
  $effect(() => {
    if (!canDirSize) return;
    const bump = dsBump, scope = dsScope;
    const list = P.searching ? P.searchItems : P.mode === 'recent' ? P.recentItems : P.items;
    const rels = list.filter((it) => it.isDir && !it.linkType).slice(0, 1000).map((it) => it.rel);
    const sig = scope + '#' + bump + '#' + [...rels].sort().join('\n');
    if (sig === dsSent) return;
    dsSent = sig;
    const payload = { client: dsClient, scope, rels, fresh: dsFresh, staleItems: [...dsStale.items], staleDirs: [...dsStale.dirs] };
    dsFresh = false; dsStale = { items: new Set(), dirs: new Set() };
    if (P.nativeFs) payload.locationId = P.locationId; else payload.root = P.wsRoot;
    untrack(() => nativeWorkspaceDirSizes(payload).then((r) => {
      for (const [rel, v] of Object.entries(r?.results || {})) dirSizes[scope + '|' + rel] = { ...v, done: true };
    }).catch(() => {}));
  });
  onMount(() => {
    if (!hasNativeDirSizes()) return;
    const off = onNativeDirSize((e) => {
      if (e?.client !== dsClient) return;
      const k = e.scope + '|' + e.key;
      if (e.error) { if (!dirSizes[k]) dirSizes[k] = { error: true, done: true }; return; }
      if (!e.done && dirSizes[k]?.done) return;   // 重算途中的半截数不盖掉上一次的最终值
      dirSizes[k] = { size: e.size, files: e.files, partial: e.partial, done: e.done };
    });
    return () => {
      off?.(); clearTimeout(dsSoonTimer);
      nativeWorkspaceDirSizes({ client: dsClient, rels: [] }).catch(() => {});   // 空清单＝取消本面板的作业
    };
  });
  function dirSizeLabel(it) {
    if (it.linkType || !canDirSize) return '—';
    const d = dirSizeOf(it);
    if (!d) return '…';
    if (d.error) return '—';
    return (d.partial && d.done ? '≥ ' : '') + fmtSize(d.size);
  }
  function dirInfoLabel(it) {
    const d = dirSizeOf(it);
    if (it.linkType || !canDirSize || d?.error) return t('文件夹');
    if (!d) return t('计算中…');
    const size = (d.partial && d.done ? '≥ ' : '') + fmtSize(d.size), n = (d.files || 0).toLocaleString(locale());
    return d.done ? t('{size}（{n} 个文件）', { size, n }) : t('{size}（{n} 个文件，统计中…）', { size, n });
  }
  function dirSizeTitle(it) {
    const d = dirSizeOf(it);
    if (!d || d.error) return undefined;
    const n = (d.files || 0).toLocaleString(locale());
    if (!d.done) return t('{n} 个文件（统计中…）', { n });
    return d.partial ? t('{n} 个文件（项目过多，只统计了一部分）', { n }) : t('{n} 个文件', { n });
  }


  return {
    get canDirSize() { return canDirSize; },
    get dirInfoLabel() { return dirInfoLabel; },
    get dirSizeLabel() { return dirSizeLabel; },
    get dirSizeOf() { return dirSizeOf; },
    get dirSizeTitle() { return dirSizeTitle; },
    get requestDirSizes() { return requestDirSizes; },
    get requestDirSizesSoon() { return requestDirSizesSoon; },
    get sizesTouched() { return sizesTouched; },
  };
}
