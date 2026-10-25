<script module>
  // 同时挂着好几个输入栏（分屏两格 / 首页大输入框）时，Ctrl+Shift+M 只给焦点所在那一个；都没焦点就给第一个
  const pickers = [];
</script>

<script>
  // 输入栏左侧的权限模式芯片 + 菜单（官方 Claude Desktop 3.1623 composer 的「Mode」按钮，A1 §8）。
  // 顺序固定：手动 / 接受编辑 / 计划 / 自动 / 绕过权限，每项一行说明，绕过权限警示色；Ctrl+Shift+M 打开，菜单里数字键直选。
  // 新会话草稿里选 = 记成这个文件夹的默认（plan 不记）；会话里选 = 只改这个会话（活着的 CLI 当场切）。
  // 可选列表以服务端为准（cs.permissionModes：主机开关 + 身份）；管理员看得到被主机关掉的自动 / 绕过权限（置灰，提示去设置里开）。
  // 自动模式首次选、绕过权限每个文件夹首次选：先弹确认框（官方文案，A1 §8.7 / §8.8）。
  import { session } from '../../lib/state.svelte.js';
  import { cs } from '../../lib/claudeSettings.svelte.js';
  import { perm, MODE_ORDER, modeLabel, modeDesc, currentMode, modeView, loadModeView, setMode, clampModeLocal } from '../../lib/permissions.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { clampX } from '../../lib/clampx.js';
  import { t } from '../../lib/i18n.js';

  let open = $state(false), btn = $state(), root = $state(), dir = $state('up');
  let active = $state(0);
  let confirm = $state(null);   // { mode, kind:'auto'|'bypass', folder }
  let cancelBtn = $state();
  // 确认框挂到 body 上：输入栏祖先只要有 transform / filter，position:fixed 就会被困在输入栏里
  function portal(node) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }

  // 视图（当前模式 / 文件夹默认 / 首次确认记录）：会话 / 项目 / 设置默认 / 主机开关变了就重取一次
  $effect(() => {
    const sid = session.id, pid = session.projectId;
    void cs.values.permissionMode; void cs.values.allowBypass; void cs.values.allowAutoMode;
    loadModeView(sid, pid);
  });

  const avail = $derived(cs.permissionModes || []);
  const rows = $derived(MODE_ORDER
    .filter((m) => avail.includes(m) || (cs.admin && (m === 'auto' || m === 'bypassPermissions')))
    .map((m) => ({ mode: m, enabled: avail.includes(m) })));
  const enabledRows = $derived(rows.filter((r) => r.enabled));
  const cur = $derived(currentMode() || clampModeLocal(cs.values.permissionMode));
  const view = $derived(modeView());
  // 绕过权限待生效：实况（perm_mode 帧 / 总线）优先——切过去之后 GET 缓存的视图里那个 pendingMode 已经过时
  const pending = $derived.by(() => {
    if (!session.id) return null;
    const live = perm.modes[session.id];
    return live ? (live.pendingMode || null) : (view?.pendingMode || null);
  });
  const defMode = $derived(clampModeLocal((view && view.folderDefault) || cs.values.permissionMode));
  const danger = $derived(cur === 'auto' || cur === 'bypassPermissions');

  function toggle() {
    if (!open && btn) { const r = btn.getBoundingClientRect(); dir = (window.innerHeight - r.bottom) >= r.top ? 'down' : 'up'; }
    open = !open;
    if (open) active = Math.max(0, enabledRows.findIndex((r) => r.mode === cur));
  }
  function close() { open = false; }

  async function choose(m) {
    close();
    if (m === cur && !pending) return;
    const v = modeView();
    if (m === 'auto' && !(v && v.consent && v.consent.auto)) { confirm = { mode: m, kind: 'auto' }; return; }
    if (m === 'bypassPermissions' && !(v && v.consent && v.consent.bypass)) { confirm = { mode: m, kind: 'bypass', folder: (v && v.folder) || '' }; return; }
    // 会话里从自动切回手动（官方 Switch to Manual?，A1 §8.7）：之后每一步都要人批，先说清楚；可勾「不再询问」（本机记）
    if (session.id && cur === 'auto' && m === 'default' && !manualNoAsk()) { confirm = { mode: m, kind: 'manual' }; noAskTick = false; return; }
    await setMode(m);
  }
  async function confirmOk() {
    const c = confirm; confirm = null;
    if (!c) return;
    if (c.kind === 'manual') { if (noAskTick) setManualNoAsk(); await setMode(c.mode); return; }
    await setMode(c.mode, { ack: true });
  }
  // 「切回手动」确认框的「不再询问」：本机偏好（localStorage，读写都可能抛——隐私模式 / 禁用存储时照常每次问）
  const NOASK_KEY = 'bridge-perm-manual-noask';
  let noAskTick = $state(false);
  function manualNoAsk() { try { return localStorage.getItem(NOASK_KEY) === '1'; } catch { return false; } }
  function setManualNoAsk() { try { localStorage.setItem(NOASK_KEY, '1'); } catch {} }

  // 安卓返回键：菜单 / 确认框先关
  $effect(() => { if (open) return pushBackLayer(close); });
  $effect(() => { if (confirm) return pushBackLayer(() => { confirm = null; }); });
  $effect(() => { if (confirm && cancelBtn) cancelBtn.focus(); });   // 官方：初始焦点在「取消」

  // 键盘：Ctrl+Shift+M 打开；菜单开着时 1…9 直选、↑↓ 移动、Enter 选中、Esc 关
  const me = { has: () => !!root && !!document.activeElement && !!root.closest('.composer')?.contains(document.activeElement) };
  $effect(() => {
    pickers.push(me);
    const onKey = (e) => {
      if (confirm) { if (e.key === 'Escape') { e.preventDefault(); confirm = null; } return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm' || e.code === 'KeyM')) {
        const owner = pickers.find((p) => p.has()) || pickers[0];
        if (owner !== me) return;
        e.preventDefault(); e.stopPropagation();
        toggle();
        return;
      }
      if (!open) return;
      if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const r = enabledRows[Number(e.key) - 1];
        if (r) { e.preventDefault(); e.stopPropagation(); choose(r.mode); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const n = enabledRows.length || 1;
        active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const r = enabledRows[active]; if (r) choose(r.mode);
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); const i = pickers.indexOf(me); if (i >= 0) pickers.splice(i, 1); };
  });

  // 16px 图标：官方 anthropicons 字形原样（Hand / Code / Scroll / Lightning / Warning，桌面包图标字体导出的填充轮廓）
  const ICON = {
    default: 'M5.65 8.4H4.75V3.79Q4.75 3.41 4.94 3.07Q5.14 2.74 5.47 2.54Q5.81 2.35 6.21 2.35Q6.59 2.35 6.93 2.54Q7.26 2.74 7.46 3.07Q7.65 3.41 7.65 3.79V7.6Q7.65 7.41 7.52 7.28Q7.39 7.15 7.2 7.15Q7.01 7.15 6.88 7.28Q6.75 7.41 6.75 7.6V2.99Q6.75 2.61 6.94 2.27Q7.14 1.94 7.47 1.74Q7.81 1.55 8.21 1.55Q8.59 1.55 8.93 1.74Q9.26 1.94 9.46 2.27Q9.65 2.61 9.65 2.99V7.6Q9.65 7.41 9.52 7.28Q9.39 7.15 9.2 7.15Q9.01 7.15 8.88 7.28Q8.75 7.41 8.75 7.6V3.79Q8.75 3.41 8.94 3.07Q9.14 2.74 9.47 2.54Q9.81 2.35 10.21 2.35Q10.59 2.35 10.93 2.54Q11.26 2.74 11.46 3.07Q11.65 3.41 11.65 3.79V8.4Q11.65 8.21 11.52 8.08Q11.39 7.95 11.2 7.95Q11.01 7.95 10.88 8.08Q10.75 8.21 10.75 8.4V6.19Q10.75 5.81 10.94 5.47Q11.14 5.14 11.47 4.94Q11.81 4.75 12.21 4.75Q12.59 4.75 12.93 4.94Q13.26 5.14 13.46 5.47Q13.65 5.81 13.65 6.19V7.6H12.75V6.19Q12.75 5.97 12.59 5.81Q12.43 5.65 12.21 5.65Q11.97 5.65 11.81 5.81Q11.65 5.97 11.65 6.19V8.4Q11.65 8.59 11.52 8.72Q11.39 8.85 11.2 8.85Q11.01 8.85 10.88 8.72Q10.75 8.59 10.75 8.4V3.79Q10.75 3.57 10.59 3.41Q10.43 3.25 10.21 3.25Q9.97 3.25 9.81 3.41Q9.65 3.57 9.65 3.79V7.6Q9.65 7.79 9.52 7.92Q9.39 8.05 9.2 8.05Q9.01 8.05 8.88 7.92Q8.75 7.79 8.75 7.6V2.99Q8.75 2.77 8.59 2.61Q8.43 2.45 8.21 2.45Q7.97 2.45 7.81 2.61Q7.65 2.77 7.65 2.99V7.6Q7.65 7.79 7.52 7.92Q7.39 8.05 7.2 8.05Q7.01 8.05 6.88 7.92Q6.75 7.79 6.75 7.6V3.79Q6.75 3.57 6.59 3.41Q6.43 3.25 6.21 3.25Q5.97 3.25 5.81 3.41Q5.65 3.57 5.65 3.79ZM12.75 7.2H13.65V8.8Q13.65 9.97 13.21 10.99Q12.77 12.02 11.99 12.79Q11.22 13.57 10.19 14.01Q9.17 14.45 8 14.45Q6.83 14.45 5.81 14.01Q4.78 13.57 4.01 12.79Q3.23 12.02 2.79 10.99Q2.35 9.97 2.35 8.8V6.4Q2.35 6.05 2.6 5.8Q2.85 5.55 3.2 5.55H3.41Q4.02 5.55 4.53 5.86Q5.04 6.16 5.34 6.67Q5.65 7.18 5.65 7.79V8.75Q6.22 8.77 6.71 9.02Q7.2 9.28 7.55 9.71Q7.9 10.14 8.03 10.69Q8.08 10.86 7.98 11.02Q7.89 11.18 7.71 11.23Q7.54 11.28 7.38 11.18Q7.22 11.09 7.17 10.91Q7.02 10.35 6.58 10Q6.13 9.65 5.55 9.65H5.2Q5.01 9.65 4.88 9.52Q4.75 9.39 4.75 9.2V7.79Q4.75 7.23 4.36 6.84Q3.97 6.45 3.41 6.45H3.2L3.25 6.4V8.8Q3.25 9.79 3.62 10.65Q3.98 11.5 4.64 12.16Q5.3 12.82 6.15 13.18Q7.01 13.55 8 13.55Q8.99 13.55 9.85 13.18Q10.7 12.82 11.36 12.16Q12.02 11.5 12.38 10.65Q12.75 9.79 12.75 8.8Z',
    acceptEdits: 'M11.31 11.12Q11.18 11.25 11 11.25Q10.82 11.25 10.69 11.12Q10.54 10.99 10.54 10.8Q10.54 10.61 10.69 10.48L13.17 8L10.69 5.52Q10.54 5.39 10.54 5.2Q10.54 5.01 10.69 4.88Q10.82 4.75 11 4.75Q11.18 4.75 11.31 4.88L14.11 7.68Q14.26 7.81 14.26 8Q14.26 8.19 14.11 8.32ZM7.65 12.88Q7.62 13.06 7.46 13.17Q7.31 13.28 7.12 13.25Q6.94 13.22 6.83 13.06Q6.72 12.91 6.75 12.72L8.35 3.12Q8.38 2.94 8.54 2.83Q8.69 2.72 8.88 2.75Q9.06 2.78 9.17 2.94Q9.28 3.09 9.25 3.28ZM5.31 10.48Q5.46 10.61 5.46 10.8Q5.46 10.99 5.31 11.12Q5.18 11.25 5 11.25Q4.82 11.25 4.69 11.12L1.89 8.32Q1.74 8.19 1.74 8Q1.74 7.81 1.89 7.68L4.69 4.88Q4.82 4.75 5 4.75Q5.18 4.75 5.31 4.88Q5.46 5.01 5.46 5.2Q5.46 5.39 5.31 5.52L2.83 8Z',
    plan: 'M5.2 2.35V3.25H3.2Q2.9 3.25 2.67 3.47Q2.45 3.7 2.45 4Q2.45 4.29 2.64 4.5Q2.77 4.64 2.76 4.82Q2.75 5.01 2.61 5.14Q2.46 5.26 2.28 5.25Q2.1 5.23 1.97 5.1Q1.55 4.64 1.55 4Q1.55 3.55 1.78 3.18Q2 2.8 2.38 2.58Q2.75 2.35 3.2 2.35ZM6 7.25Q5.81 7.25 5.68 7.12Q5.55 6.99 5.55 6.8Q5.55 6.61 5.68 6.48Q5.81 6.35 6 6.35L6.13 6.32L6.26 6.24L6.42 6.06L6.54 5.82Q6.62 5.65 6.79 5.58Q6.96 5.52 7.13 5.58Q7.3 5.65 7.38 5.82L7.5 6.06L7.66 6.24L7.79 6.32L7.92 6.35L8.05 6.32L8.18 6.24L8.34 6.06L8.46 5.82Q8.54 5.65 8.71 5.58Q8.88 5.52 9.05 5.58Q9.22 5.65 9.3 5.82L9.42 6.06L9.58 6.24L9.71 6.32L9.84 6.35L9.97 6.32L10.1 6.24L10.26 6.06L10.38 5.82Q10.46 5.65 10.63 5.58Q10.8 5.52 10.98 5.58Q11.15 5.66 11.22 5.83Q11.28 6 11.22 6.18L10.99 6.59Q10.86 6.77 10.69 6.92Q10.51 7.07 10.3 7.17Q9.84 7.34 9.38 7.17Q9.18 7.07 8.99 6.93L8.88 6.82L8.77 6.93Q8.58 7.07 8.38 7.17Q7.92 7.34 7.46 7.17Q7.26 7.07 7.07 6.93L6.96 6.82L6.85 6.93Q6.66 7.07 6.46 7.17Q6.24 7.25 6 7.25ZM3.2 3.25V2.35H4.4Q4.59 2.35 4.72 2.48Q4.85 2.61 4.85 2.8V12Q4.85 12.3 5.07 12.53Q5.3 12.75 5.6 12.75H12.8Q13.1 12.75 13.33 12.53Q13.55 12.3 13.55 12V11.25H7.25V12Q7.25 12.45 7.02 12.82Q6.8 13.2 6.42 13.42Q6.05 13.65 5.6 13.65Q5.41 13.65 5.28 13.52Q5.15 13.39 5.15 13.2Q5.15 13.01 5.28 12.88Q5.41 12.75 5.6 12.75Q5.9 12.75 6.13 12.53Q6.35 12.3 6.35 12V10.8Q6.35 10.61 6.48 10.48Q6.61 10.35 6.8 10.35H14Q14.19 10.35 14.32 10.48Q14.45 10.61 14.45 10.8V12Q14.45 12.45 14.22 12.82Q14 13.2 13.62 13.42Q13.25 13.65 12.8 13.65H5.6Q5.15 13.65 4.78 13.42Q4.4 13.2 4.18 12.82Q3.95 12.45 3.95 12V3.25ZM11.95 4Q11.95 3.81 12.08 3.68Q12.21 3.55 12.4 3.55Q12.59 3.55 12.72 3.68Q12.85 3.81 12.85 4V10.8H11.95ZM4.4 3.25V2.35H11.2Q11.65 2.35 12.02 2.58Q12.4 2.8 12.62 3.18Q12.85 3.55 12.85 4Q12.85 4.19 12.72 4.32Q12.59 4.45 12.4 4.45Q12.21 4.45 12.08 4.32Q11.95 4.19 11.95 4Q11.95 3.7 11.73 3.47Q11.5 3.25 11.2 3.25Z',
    auto: 'M9.68 3.14 9.04 6.1Q9.09 5.89 8.95 5.72Q8.82 5.55 8.61 5.55H12.22Q12.59 5.55 12.89 5.74Q13.18 5.94 13.33 6.24Q13.49 6.54 13.46 6.9Q13.44 7.25 13.22 7.54L8.56 13.87Q8.27 14.26 7.84 14.35Q7.41 14.45 7.04 14.27Q6.66 14.1 6.44 13.72Q6.22 13.34 6.32 12.86L6.96 9.9Q6.91 10.11 7.05 10.28Q7.18 10.45 7.41 10.45H3.79Q3.41 10.45 3.11 10.26Q2.82 10.06 2.67 9.76Q2.51 9.46 2.54 9.1Q2.56 8.75 2.78 8.46L7.44 2.13Q7.73 1.74 8.16 1.65Q8.59 1.55 8.96 1.73Q9.34 1.9 9.56 2.28Q9.78 2.66 9.68 3.14ZM8.8 2.94Q8.83 2.77 8.75 2.67Q8.67 2.58 8.59 2.54Q8.53 2.51 8.41 2.52Q8.29 2.53 8.18 2.67L3.5 8.99Q3.38 9.17 3.47 9.36Q3.57 9.55 3.79 9.55H7.41Q7.62 9.55 7.75 9.72Q7.89 9.89 7.84 10.1L7.2 13.06Q7.17 13.23 7.25 13.33Q7.33 13.42 7.41 13.46Q7.47 13.49 7.59 13.48Q7.71 13.47 7.82 13.33L12.5 7.01Q12.62 6.83 12.53 6.64Q12.43 6.45 12.22 6.45H8.61Q8.38 6.45 8.25 6.28Q8.11 6.11 8.16 5.9Z',
    bypassPermissions: 'M7.87 6.02Q7.9 5.82 8.05 5.72Q8.19 5.62 8.38 5.63Q8.58 5.66 8.68 5.81Q8.78 5.95 8.77 6.14L8.45 8.38Q8.42 8.58 8.29 8.67Q8.16 8.77 8 8.77Q7.84 8.77 7.71 8.67Q7.58 8.58 7.55 8.38L7.23 6.14Q7.2 5.94 7.34 5.78Q7.47 5.63 7.68 5.63H8.3Q8.5 5.63 8.62 5.76Q8.75 5.89 8.75 6.08Q8.75 6.27 8.62 6.4Q8.5 6.53 8.3 6.53H7.68Q7.89 6.53 8.02 6.38Q8.16 6.22 8.13 6.02L8.45 8.26Q8.42 8.06 8.29 7.97Q8.16 7.87 8 7.87Q7.84 7.87 7.71 7.97Q7.58 8.06 7.55 8.26ZM7.95 9.55Q8.13 9.54 8.27 9.66Q8.42 9.79 8.42 9.97Q8.43 10.16 8.31 10.3Q8.19 10.43 8 10.45L8.05 10.4L8 10.35L7.95 10.4L8 10.45Q8.18 10.46 8.32 10.34Q8.46 10.21 8.48 10.03L8.45 10.43Q8.43 10.61 8.3 10.74Q8.16 10.86 7.97 10.85Q7.79 10.83 7.66 10.7Q7.54 10.56 7.55 10.37L7.58 9.97Q7.58 9.79 7.73 9.66Q7.87 9.54 8.05 9.55Q8.38 9.57 8.62 9.82Q8.85 10.06 8.85 10.4Q8.85 10.75 8.6 11Q8.35 11.25 8 11.25Q7.65 11.25 7.4 11Q7.15 10.75 7.15 10.4Q7.15 10.06 7.38 9.82Q7.62 9.57 7.95 9.55ZM12.21 13.65H3.81Q3.18 13.65 2.67 13.34Q2.16 13.04 1.86 12.53Q1.55 12.02 1.55 11.41V11.31Q1.55 10.67 1.89 10.13L6.14 3.31Q6.43 2.86 6.9 2.61Q7.36 2.35 7.89 2.35H8.11Q8.64 2.35 9.1 2.61Q9.57 2.86 9.86 3.31L14.11 10.13Q14.45 10.67 14.45 11.31V11.41Q14.45 12.02 14.14 12.53Q13.84 13.04 13.33 13.34Q12.82 13.65 12.21 13.65ZM12.21 12.75Q12.58 12.75 12.88 12.57Q13.18 12.38 13.37 12.08Q13.55 11.78 13.55 11.41V11.31Q13.55 10.93 13.34 10.61L9.09 3.79Q8.75 3.25 8.11 3.25H7.89Q7.25 3.25 6.91 3.79L2.66 10.61Q2.45 10.93 2.45 11.31V11.41Q2.45 11.78 2.63 12.08Q2.82 12.38 3.12 12.57Q3.42 12.75 3.81 12.75Z',
  };
</script>

<div class="pmp" bind:this={root}>
  <button type="button" class="chip" class:warn={cur === 'bypassPermissions'} bind:this={btn} aria-haspopup="menu" aria-expanded={open}
    aria-label={t('权限模式：{mode}', { mode: modeLabel(cur) })}
    title={pending ? t('Claude 这一轮结束后开启绕过权限') : danger ? t('Claude 可以不经询问修改或删除文件') : t('权限模式') + ' · Ctrl+Shift+M'}
    onclick={toggle}>
    <svg class="ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={ICON[cur] || ICON.default} /></svg>
    <span class="lbl">{modeLabel(cur)}</span>
    {#if pending}<span class="dot" aria-hidden="true"></span>{/if}
  </button>

  {#if open}
    <button class="backdrop" aria-label={t('关闭')} onclick={close}></button>
    <div class="menu" class:down={dir === 'down'} role="menu" use:clampX={{ anchor: 'left' }}>
      <div class="mh">{t('权限模式')}</div>
      {#each rows as r (r.mode)}
        {@const n = enabledRows.indexOf(r) + 1}
        <button type="button" class="mi" class:on={r.mode === cur} class:act={n > 0 && enabledRows[active] === r} class:warn={r.mode === 'bypassPermissions'}
          role="menuitemradio" aria-checked={r.mode === cur} disabled={!r.enabled}
          title={r.enabled ? '' : t('在设置里开启')} onclick={() => r.enabled && choose(r.mode)}>
          <svg class="ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={ICON[r.mode]} /></svg>
          <span class="txt">
            <span class="nm">{modeLabel(r.mode)}{#if r.mode === defMode && r.enabled}<span class="badge">{t('默认')}</span>{/if}</span>
            <span class="ds">{!r.enabled ? t('在设置里开启') : r.mode === 'bypassPermissions' && pending ? t('Claude 这一轮结束后开启') : modeDesc(r.mode)}</span>
          </span>
          {#if r.mode === cur}
            <svg class="ck" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>
          {:else if n > 0 && n < 10}<span class="num">{n}</span>{/if}
        </button>
      {/each}
      <div class="mf">{session.id ? t('只改这个会话') : t('记成这个文件夹的默认')}</div>
    </div>
  {/if}
</div>

{#if confirm}
  <div class="cf-wrap" role="presentation" use:portal>
    <button class="cf-back" aria-label={t('取消')} onclick={() => (confirm = null)}></button>
    <div class="cf" role="alertdialog" aria-modal="true" aria-labelledby="pmp-cf-t">
      {#if confirm.kind === 'auto'}
        <div class="cf-t" id="pmp-cf-t">{t('启用自动模式？')}</div>
        <div class="cf-b">{t('Claude 会自行判断哪些操作可以不经询问直接执行。较长的任务可以不被打断地运行，并有额外的提示注入防护。')}</div>
        <div class="cf-f">{t('以后不会再问。自动模式的审核请求会计入用量。')}</div>
      {:else if confirm.kind === 'manual'}
        <div class="cf-t" id="pmp-cf-t">{t('切回手动？')}</div>
        <div class="cf-b">{t('Claude 每一步操作前都会先请你批准。自动模式会替你审核每一步，并拦下有风险的操作。')}</div>
        <label class="cf-ck"><input type="checkbox" bind:checked={noAskTick} />{t('不再询问')}</label>
      {:else}
        <div class="cf-t" id="pmp-cf-t">{t('要绕过所有权限吗？')}</div>
        <div class="cf-b">{t('Claude 会不经询问地读取、编辑和执行文件，包括可能具有破坏性的命令。仅应在隔离或一次性的环境中使用。')}</div>
        {#if confirm.folder}<div class="cf-path">{confirm.folder}</div>{/if}
        <div class="cf-f">{confirm.folder ? t('这个工作区以后不会再问。') : ''}</div>
      {/if}
      <div class="cf-acts">
        <button type="button" class="cf-btn" bind:this={cancelBtn} onclick={() => (confirm = null)}>{t('取消')}</button>
        <button type="button" class="cf-btn primary" class:warn={confirm.kind === 'bypass'} onclick={confirmOk}>{confirm.kind === 'auto' ? t('启用自动模式') : confirm.kind === 'manual' ? t('切回手动') : t('绕过权限')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pmp { position: relative; display: flex; flex: none; min-width: 0; }
  /* 素文本芯片（与模型 / Effort 芯片同族）：图标 + 当前模式；绕过权限警示色 */
  .chip { display: flex; align-items: center; gap: 5px; height: 38px; padding: 0 9px 0 8px; border-radius: 10px; color: var(--muted); font-size: 13.5px; white-space: nowrap; min-width: 0; }
  .chip:active { background: var(--hover); }
  @media (hover: hover) { .chip:hover { background: var(--hover); color: var(--text); } }
  .chip.warn { color: var(--crit, #d9534f); }
  .ico { flex: none; width: 16px; height: 16px; }
  .lbl { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--crit, #d9534f); }
  /* 窄屏（手机竖屏 / 折叠屏分屏）：只留图标，保住发送键不被挤出卡片 */
  @media (max-width: 380px) { .lbl { display: none; } .chip { padding: 0 8px; } }

  .backdrop { position: fixed; inset: 0; z-index: 60; }
  .menu { position: absolute; left: 0; bottom: calc(100% + 8px); z-index: 61; width: max-content; min-width: 236px; max-width: min(320px, 92vw);
    padding: 6px 0; background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow); max-height: 70vh; overflow-y: auto;
    animation: pmpPop var(--mo-quick, .16s) var(--ea-decel, ease-out); cursor: default; }
  .menu.down { bottom: auto; top: calc(100% + 8px); }
  @keyframes pmpPop { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
  .mh { padding: 4px 12px 4px; font-size: 12px; color: var(--muted); }
  .mi { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 7px 12px; text-align: left; color: var(--text); }
  .mi .ico { margin-top: 2px; color: var(--muted); }
  .mi.on .ico { color: var(--text); }
  .mi.warn .ico, .mi.warn .nm { color: var(--crit, #d9534f); }
  .mi:disabled { opacity: .45; cursor: default; }
  .mi.act, .mi:active:not(:disabled) { background: var(--hover); }
  @media (hover: hover) { .mi:hover:not(:disabled) { background: var(--hover); } }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .nm { display: flex; align-items: center; gap: 6px; font-size: 13.5px; line-height: 19px; }
  .ds { font-size: 12px; line-height: 16px; color: var(--muted); }
  .badge { padding: 0 5px; border-radius: 4px; font-size: 10.5px; line-height: 15px; color: var(--muted); background: var(--hover-strong, var(--hover)); }
  .ck { flex: none; width: 15px; height: 15px; margin-top: 2px; color: var(--text); }
  .num { flex: none; width: 15px; text-align: center; font-size: 11.5px; line-height: 19px; color: var(--muted); }
  .mf { padding: 6px 12px 2px; margin-top: 4px; border-top: 1px solid var(--divider); font-size: 11.5px; color: var(--muted); }
  @media (pointer: coarse) { .num { display: none; } }

  /* 首次确认框（官方 ConfirmDialog：标题 / 说明 / 工作区路径等宽 / 脚注；初始焦点在「取消」） */
  .cf-wrap { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 16px; cursor: default; }
  .cf-back { position: absolute; inset: 0; background: rgba(0,0,0,.42); }
  .cf { position: relative; width: min(420px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 18px 18px 14px; border-radius: 14px;
    background: var(--card); box-shadow: 0 18px 60px rgba(0,0,0,.35); color: var(--text); animation: pmpPop var(--mo-quick, .16s) var(--ea-decel, ease-out); }
  .cf-t { font-size: 16px; line-height: 22px; font-weight: 600; }
  .cf-b { font-size: 14px; line-height: 21px; color: var(--serif); text-wrap: pretty; }
  .cf-path { padding: 7px 10px; border-radius: 8px; background: var(--hover); font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .cf-f { font-size: 12.5px; line-height: 18px; color: var(--muted); }
  .cf-f:empty { display: none; }
  .cf-ck { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); cursor: pointer; align-self: flex-start; }
  .cf-ck input { margin: 0; width: 15px; height: 15px; accent-color: var(--text); }
  .cf-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .cf-btn { min-height: 34px; padding: 6px 14px; border-radius: 9px; font-size: 14px; font-weight: 500; color: var(--text); border: 1px solid var(--q-skipborder, var(--divider)); }
  @media (hover: hover) { .cf-btn:hover { background: var(--hover); } }
  .cf-btn.primary { background: var(--text); color: var(--bg); border-color: transparent; }
  .cf-btn.primary.warn { background: var(--crit, #d9534f); color: #fff; }
</style>
