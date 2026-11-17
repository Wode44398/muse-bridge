// 桌面设置 › 连接与更新：服务器地址、软件更新（含空闲后自动更新）、服务端更新、公网地址、手机扫码连接 / 下载 App、服务端控制台入口、
// 桌面壳托管的服务进程。外壳 SettingsDesktop.svelte 按原来的先后创建（effect 与请求次序不变）。
import { untrack } from 'svelte';
import { me } from '../../lib/state.svelte.js';
import { t, tc, tr } from '../../lib/i18n.js';
import { getServerBase, apiUrl } from '../../lib/server.js';
import { updateState, installPending, hasSilentUpdate, checkForUpdate, startUpdate,
  autoUpdateEnabled, setAutoUpdateEnabled, appDownloadUrls, cancelPendingInstall, waitingLine } from '../../lib/appUpdate.js';
import { qrSvg } from '../../lib/pair.js';
import { serverOnThisMachine } from '../../lib/nativeDesktop.js';
import { createServerUpdate } from '../../lib/serverUpdate.svelte.js';
import { createServerAddress, createServerInfo, createSrvAdminProbe } from '../../lib/settings/common.svelte.js';

export function createDeskConnect(D) {
  // ═══ 连接与更新 ═══
  const addr = createServerAddress(getServerBase() || '');   // 地址框与「连接」两套外壳共用（lib/settings/common.svelte.js）

  let upState = $state('idle'), progress = $state(0), upMsg = $state(t('检查更新')), upErr = $state('');
  // 上一次「空闲后自动更新」没装成的原因（等满 30 分钟 / 服务端那边取消了 / 安装包不见了…）：壳写在 ready 状态的 note 里（带 noteAt）。
  // 不是错误，用中性说明样式；过一天不再显示，下次点「一键更新」也清掉。用户自己点的「取消等待」壳不写 note。
  let upNote = $state('');
  const noteOf = (st) => (st && st.note && (!st.noteAt || Date.now() - st.noteAt < 24 * 3600_000) ? tr(st.note) : '');
  let pollTimer = null;
  (() => {
    const st = updateState();
    if (st.state === 'ready') { upState = 'installable'; upMsg = t('一键更新'); upNote = noteOf(st); }
    else if (st.state === 'downloading') { upState = 'downloading'; progress = (st.pct || 0) / 100; upMsg = t('正在下载'); pollState(); }
    // 托管着本机服务端、正等所有人的对话跑完去装（S1-5）
    else if (st.state === 'waiting-idle') { upState = 'waiting'; upMsg = waitingLine(st); pollState(); }
    // 服务端已经在退、马上起安装器：撤不回了，只转圈
    else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); pollState(); }
    // 装到一半被静默中止过：壳启动时对账出来的。不说出来，用户只会看到「又提示有新版」。
    else if (st.state === 'failed') { upState = 'error'; upMsg = t('上次更新没装上，点击重试'); upErr = tr(st.error || ''); }
  })();
  function pollState() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const st = updateState();
      if (st.state === 'ready') { progress = 1; upState = 'installable'; upMsg = t('一键更新'); upNote = noteOf(st); clearInterval(pollTimer); }
      else if (st.state === 'downloading') { progress = (st.pct || 0) / 100; }
      else if (st.state === 'waiting-idle') { upState = 'waiting'; upMsg = waitingLine(st); }
      else if (st.state === 'handing-off') { upState = 'checking'; upMsg = t('正在拉起安装…'); }
      else if (st.state === 'installing') { upState = 'checking'; upMsg = t('正在拉起安装…'); clearInterval(pollTimer); }
      else { upState = 'error'; upMsg = tc('settings', '下载失败，点击重试'); clearInterval(pollTimer); }
    }, 500);
  }
  // 一键更新：托管着本机服务端、有对话在跑时，壳会先问「空闲后自动更新 / 立即更新」（S1-5）。点下去就转圈（别留一个还能再点的按钮）
  async function installNow(mode) {
    upErr = ''; upNote = '';
    upState = 'checking'; upMsg = t('正在拉起安装…');
    const r = await installPending(mode ? { mode } : undefined);
    if (r && r.cancelled) { upState = 'installable'; upMsg = t('一键更新'); return; }
    // 这次没装（服务端没接下 / 没应答）：壳已回到「可以装」，把原因说一句
    if (r && r.ok === false && r.error) { upState = 'installable'; upMsg = t('一键更新'); upNote = tr(r.error); return; }
    if (r && r.waiting) { upState = 'waiting'; upMsg = waitingLine(r); }
    pollState();
  }
  async function onCancelWait() {
    const r = await cancelPendingInstall();
    // 服务端已经在退出去装了：撤不回（壳回 error），照实说
    if (r && r.ok === false && r.error) upNote = tr(r.error);
    pollState();
  }
  // 壳经 IPC 抛回来的错带着 Electron 的前缀（Error invoking remote method 'update:check': Error: …）：只留壳自己的那句
  const ipcErr = (e) => String(e?.message || e || '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
  async function onUpdate() {
    if (upState === 'downloading' || upState === 'checking') return;
    if (upState === 'installable') { installNow(); return; }
    upState = 'checking'; upMsg = t('检查中…'); upErr = ''; upNote = '';
    let checked;
    // 10-28：以前一律说「连不上服务器」，壳给的真原因（没配对、服务端回 404…）被吞了，服主只看到「点了没用」
    try { checked = await checkForUpdate(); }
    catch (e) { upState = 'error'; upMsg = t('检查更新失败'); upErr = tr(ipcErr(e)); return; }
    if (!checked?.available) {
      const lt = checked?.latest || {};
      upState = 'latest'; upMsg = t('已是最新版本');
      // 服务端查 GitHub 没查到（服主那台：本机服务端拿上游清单）：别装作已是最新
      if (lt.feed && lt.feed.ok === false && lt.feed.checkedAt) {
        upMsg = t('暂时查不到新版本');
        upNote = t('服务端查不到 GitHub 上的新版本：{error}', { error: tr(lt.feed.error || '') });
      } else if (lt.pinned) {
        // 成员：客户端跟随服务器那一版（服务端只发同一次发布的客户端），服主升级后这里才会有新版
        upNote = t('客户端跟随服务器的版本（v{v}）：服务器更新后，这里就能更新到同一版', { v: lt.pinned });
      }
      return;
    }
    if (hasSilentUpdate()) {
      upState = 'downloading'; progress = 0; upMsg = t('正在下载');
      try { await startUpdate(checked.latest || {}); } catch { upState = 'error'; upMsg = t('下载失败'); return; }
      pollState();
    } else {
      await startUpdate(checked.latest || {});
      upState = 'done'; upMsg = t('已开始下载');
    }
  }
  $effect(() => () => clearInterval(pollTimer));
  // 服务端更新（管理员，lib/serverUpdate.svelte.js）：查 GitHub 上的版本、一键更新服务端。服务端就装在这台电脑、随客户端安装包走时
  // （壳带更新桥 + 服务端在本机），上面的「软件更新」就是它——不重复摆一组。
  const srvUpd = createServerUpdate();
  const srvUpdShow = $derived(!!srvUpd.st && !(hasSilentUpdate() && serverOnThisMachine()));
  const srvUpdView = $derived(srvUpd.view);
  $effect(() => {
    if (D.sec !== 'connect' || me.kind !== 'admin') return;
    untrack(() => srvUpd.load());
  });
  // 自动检查更新（启动时检查、后台下好，装不装由你）：只有带自更新桥的壳有（附着本机工程的形态没有）
  let autoUp = $state(autoUpdateEnabled());
  function onAutoUp(v) { autoUp = v; setAutoUpdateEnabled(v); }

  // 服务器那头（要登录）：公网地址 / 后端运行多久——原单页设置「连接」页的内容，进「连接与更新」才拉。
  // /api/app/server-info 不给隧道状态（没有 tunnel 字段），所以这里也不摆「公网隧道」行。
  const srv = createServerInfo();   // srvInfo、复制公网地址：两套外壳共用
  let connectOpen = $state(false);   // 「手机扫码连接」点开才出码（S1-2，components/pairing/ConnectQr.svelte）
  $effect(() => { if (D.sec !== 'connect') connectOpen = false; });
  $effect(() => {
    if (D.sec !== 'connect' || me.kind === 'none') return;
    untrack(() => srv.load());
  });
  // 后端跑了多久：fmtUptime（lib/settings/common.js）

  // 手机扫码下载 App（S1-4：手机 App 由这台服务器自己发，/download/android）。只在服务器手里真有包、且是单人服务器时出码
  // （多人服务器上下载要先登录，手机相机扫开的浏览器还没登录）。局域网地址快、只在同一个 Wi-Fi 里通；公网的出门也能下。
  let apkVer = $state(null);
  $effect(() => {
    if (D.sec !== 'connect') return;
    untrack(() => fetch(apiUrl('/api/app/version'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => { apkVer = v; }).catch(() => {}));
  });
  // 默认出公网地址的码（出门也能下）；只有这页本身就是经局域网地址打开的、或没有公网地址时才默认局域网的。
  // dlWhich 是用户点「改用…」后的选择，空 = 按默认。局域网候选服务端只给手机真连得上的（app-update.mjs lanCandidates）
  let dlWhich = $state('');
  let dlQr = $state('');
  const dlUrls = $derived(appDownloadUrls(srv.srvInfo));
  const pageOnLan = (() => {
    try { return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(getServerBase() || location.origin).hostname); } catch { return false; }
  })();
  const dlPick = $derived(dlWhich || (pageOnLan || !dlUrls.pub ? 'lan' : 'pub'));
  const dlUrl = $derived(dlPick === 'pub' ? (dlUrls.pub || dlUrls.lan) : (dlUrls.lan || dlUrls.pub));
  const dlShow = $derived(!!(srv.srvInfo && !srv.srvInfo.multiUser && apkVer && apkVer.available && dlUrl));
  $effect(() => {
    const u = dlShow ? dlUrl : '';
    if (!u) { dlQr = ''; return; }
    qrSvg(u).then((s) => { if (u === dlUrl) dlQr = s; }).catch(() => { dlQr = ''; });
  });

  // 服务端控制台入口：服务端就在这台电脑上（本机直连放行），或服务端开着远程管理（features.remoteAdmin）时的管理员（探针两套外壳共用）。
  const srvAdmin = createSrvAdminProbe();

  // ═══ 服务进程（壳原生，掉线也在）═══
  // 状态与「启停/重启/日志」都在壳的控制台窗口里，这里只做入口 + 一句实时状态。
  let spState = $state(null);
  function refreshSp() { D.spCtl?.status().then((s) => { if (s) spState = s; }).catch(() => {}); }
  $effect(() => {
    if (!D.spCtl || D.sec !== 'connect') return;
    refreshSp();
    // 壳侧状态要跑 admin.ps1 status（冷起 PowerShell + WMI，几秒）：15 秒一次、窗口在后台不拉；掉线 / 恢复有 onHealth 即时推（FR3）
    const timer = setInterval(() => { if (!document.hidden) refreshSp(); }, 15000);
    const off = D.spCtl.onHealth ? D.spCtl.onHealth(() => refreshSp()) : null;
    return () => { clearInterval(timer); try { off && off(); } catch {} };
  });
  const spLine = $derived(!spState ? t('读取中…')
    : spState.health === 'up' ? (spState.server?.pid ? t('运行中 · PID {pid}', { pid: spState.server.pid }) : t('运行中'))
    : spState.health === 'unresponsive' ? t('进程在，但没有应答')
    : t('已停止 · 点这里启动'));
  // 退出 App 会连带停掉本机服务端（壳托管的 managed 形态）：点「退出」先问一句，默认隐藏到托盘、服务端照常在线（S1-3）。
  // 插电时保持在线（S1-3）：这台电脑当服务器，插着电就不闲置睡眠。真相都在主进程（client.json），老壳没有这些字段 → 行不出现。
  let spPrefs = $state(null);
  $effect(() => {
    if (!D.spCtl?.prefs || D.sec !== 'connect') return;
    D.spCtl.prefs().then((p) => { if (p) spPrefs = p; }).catch(() => {});
  });
  async function onConfirmQuit(v) {
    try { const r = await D.spCtl.setPrefs({ confirmQuit: v }); if (r) spPrefs = { ...spPrefs, ...r }; } catch { /* 保持原状 */ }
  }
  async function onKeepOnline(v) {
    try { const r = await D.spCtl.setPrefs({ keepOnline: v }); if (r) spPrefs = { ...spPrefs, ...r }; } catch { /* 保持原状 */ }
  }
  // acSleepMin：电源计划里插电闲置多少分钟睡眠（0 = 从不，null = 读不出）
  const keepOnlineSub = $derived(!spPrefs ? ''
    : spPrefs.keepOnline
      ? (spPrefs.onBattery ? t('现在在用电池：照常睡眠，插上电再接着保持在线') : t('这台电脑当服务器：插着电时不会闲置睡眠（屏幕照常关），手机随时连得上；用电池时照常睡眠'))
      : spPrefs.acSleepMin > 0 ? t('关着：插电闲置 {n} 分钟后电脑会睡眠，睡着时手机连不上', { n: spPrefs.acSleepMin })
      : spPrefs.acSleepMin === 0 ? t('关着：电源计划本来就不让电脑自动睡眠，手机随时连得上')
      : t('关着：电脑按电源计划睡眠，睡着时手机连不上'));
  return {
    addr,
    get upState() { return upState; }, get progress() { return progress; }, get upMsg() { return upMsg; }, get upErr() { return upErr; }, get upNote() { return upNote; },
    installNow, onCancelWait, onUpdate,
    srvUpd, get srvUpdShow() { return srvUpdShow; }, get srvUpdView() { return srvUpdView; }, get autoUp() { return autoUp; }, onAutoUp,
    get srvInfo() { return srv.srvInfo; }, get connectOpen() { return connectOpen; }, set connectOpen(v) { connectOpen = v; },
    get pubCopied() { return srv.pubCopied; }, copyPublic: srv.copyPublic,
    get dlWhich() { return dlWhich; }, set dlWhich(v) { dlWhich = v; }, get dlQr() { return dlQr; }, get dlUrls() { return dlUrls; }, get dlPick() { return dlPick; },
    get dlUrl() { return dlUrl; }, get dlShow() { return dlShow; },
    get srvAdminOk() { return srvAdmin.ok; }, get spState() { return spState; }, get spLine() { return spLine; }, get spPrefs() { return spPrefs; },
    onConfirmQuit, onKeepOnline, get keepOnlineSub() { return keepOnlineSub; },
  };
}
