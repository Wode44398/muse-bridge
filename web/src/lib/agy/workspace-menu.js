// Antigravity 侧栏工作空间长按菜单项构筑（纯逻辑，便于单测）。
// 侧栏分组既可能来自已保存项目，也可能来自「最近用过」或旧历史会话目录：
//   · 置顶 / 取消置顶、重命名（只改侧栏显示名，不动文件夹）始终可用；
//   · 只要该组底下还有会话，提供「隐藏全部对话 (N)」让用户一键从侧栏清掉整组（可在「已隐藏」恢复）；
//   · 已保存项目与「最近用过」（排除默认根目录）均提供「移除工作空间」，与顶栏文件夹列表对齐；
//   · 插件给的文件夹菜单项（pluginItems，已是菜单条目形状）插在置顶之后、隐藏 / 移除之前，前后用分隔线隔开。

import { t } from '../i18n.js';

export function sameDirPath(a = '', b = '') {
  const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!na || !nb) return false;
  return /^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function buildSidebarWorkspaceMenu({
  pgrp,
  projects = [],
  recentDirs = [],
  defaultCwd = '',
  sessionIds = [],
  pluginItems = [],
  onPin,
  onRename,
  onHideAll,
  onRemove,
} = {}) {
  if (!pgrp || pgrp.unassigned) return [];
  const projList = Array.isArray(projects) ? projects : [];
  const recentList = Array.isArray(recentDirs) ? recentDirs : [];
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((x) => String(x || '').trim()).filter(Boolean))];

  const saved = projList.find((p) => (pgrp.projectId && p.id === pgrp.projectId) || (pgrp.path && sameDirPath(p.path, pgrp.path))) || null;
  const isDefault = Boolean(pgrp.path && defaultCwd && sameDirPath(pgrp.path, defaultCwd));
  const isRecent = !saved && !isDefault && Boolean(pgrp.path) && recentList.some((d) => d?.path && sameDirPath(d.path, pgrp.path));
  const canRemove = Boolean(saved || isRecent);
  const pinned = Boolean(saved?.pinned || pgrp.pinned);

  const out = [
    {
      id: pinned ? 'unpin' : 'pin',
      label: pinned ? t('取消置顶') : t('置顶'),
      icon: pinned ? 'unpin' : 'pin',
      onclick: () => onPin?.({
        id: saved?.id || pgrp.projectId || '',
        path: saved?.path || pgrp.path || '',
        name: pgrp.name,
        pinned: !pinned,
      }),
    },
  ];

  if (pgrp.path || saved) {
    out.push({
      id: 'rename',
      label: t('重命名'),
      icon: 'edit',
      onclick: () => onRename?.({
        id: saved?.id || pgrp.projectId || '',
        path: saved?.path || pgrp.path || '',
        name: pgrp.name,
      }),
    });
  }

  const plug = (Array.isArray(pluginItems) ? pluginItems : []).filter((x) => x && !x.sep && x.label);
  if (plug.length > 0) {
    out.push({ sep: true }, ...plug);
  }

  if (ids.length > 0 || canRemove) {
    out.push({ sep: true });
  }

  if (ids.length > 0) {
    out.push({
      id: 'hide-all',
      label: t('隐藏全部对话 ({n})', { n: ids.length }),
      icon: 'visibility_off',
      onclick: () => onHideAll?.(ids, pgrp.name),
    });
  }

  if (canRemove) {
    const removeTarget = saved
      ? { id: saved.id, path: saved.path, name: saved.name }
      : { id: '', path: pgrp.path, name: pgrp.name };
    out.push({
      id: 'delete',
      label: t('移除工作空间'),
      icon: 'delete',
      danger: true,
      onclick: () => onRemove?.(removeTarget),
    });
  }

  return out;
}
