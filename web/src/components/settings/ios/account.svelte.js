// 设置 › 账户（iOS 外壳，设置 App 顶上那张 Apple 账户卡）：资料、用量、改密码、切换账号、退出；没登录时这一页就是登录页。
import { untrack } from 'svelte';
import { ui, me, status } from '../../../lib/state.svelte.js';
import { t, tr } from '../../../lib/i18n.js';
import { api } from '../../../lib/api.js';
import { signIn, signUp, signInToken, signOut, recentUsers, forgetUser, savedAccounts, switchTo, parkCurrent, forgetAccount } from '../../../lib/account.js';
import { fetchMyUsage } from '../../../lib/me.js';
import { fetchAdminAccess, saveAdminAccess, onAdminAccess } from '../../../lib/adminAccess.js';
import { isOffline } from '../../../lib/server.js';
import { loadAuthProviders } from '../../../lib/authProviders.svelte.js';
import { roleLabelOf } from '../../../lib/settings/common.js';
import { createPairLogin, createPasswordChange } from '../../../lib/settings/common.svelte.js';

export function createAccount(S) {
  // —— 账户（设置 App 顶上那张 Apple 账户卡）：资料、用量、改密码、切换账号、退出；没登录时这一页就是登录页。
  // 原先这些散在主页右上的账户胶囊卡和 Claude 侧栏菜单里，退出登录也在菜单里——统一收进这里。
  // 身份那一行（两套外壳共用，lib/settings/common.js 的 roleLabelOf；tier 'pro' = 「完全信任」档）
  const roleLabel = $derived(roleLabelOf(me));
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'Admin' : ''));
  const initial = $derived((shownName || '?').trim().charAt(0).toUpperCase());
  // 「扫一扫登录网页版」只给手机形态（apk / 触屏）；网页登录页的「扫码登录」反过来只给电脑
  const canScan = (() => { try { return isOffline() || matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  const acctOpen = $derived(S.nav.stack.includes('account'));
  // 登录页一露面就拉一次外部登录方式（离线 App 里不拉、不显示）
  $effect(() => { if (acctOpen && me.kind === 'none') untrack(() => loadAuthProviders()); });
  // 用量：进账户页才拉
  let mine = $state(null);
  $effect(() => {
    if (!acctOpen || me.kind === 'none') return;
    api.status().then((s) => { status.limits = s.limits || null; status.context = s.context || null; if (s.plan) status.plan = s.plan; status.updatedAt = Date.now(); }).catch(() => {});
    if (me.kind === 'user') fetchMyUsage().then((r) => { mine = r; }).catch(() => {});
    if (me.kind === 'user') loadAa();
  });
  // 管理员可见性（S2-7，lib/adminAccess.js）：成员自己决定管理员能不能看内容 / 代聊代答 / 看他的电脑，并看访问记录
  let aa = $state(null);
  const loadAa = () => fetchAdminAccess().then((r) => { aa = r && !r.admin ? r : null; }).catch(() => {});
  // 账户页开着时管理员刚看过 / 代操作过：访问记录当场刷新（提示由 lib/adminAccess.js 统一弹）
  $effect(() => (acctOpen && me.kind === 'user' ? onAdminAccess(() => loadAa()) : undefined));
  async function toggleAa(key) {
    if (!aa) return;
    const next = !aa.consents[key];
    aa.consents[key] = next;
    try { const r = await saveAdminAccess({ [key]: next }); if (r?.consents) aa.consents = r.consents; } catch { aa.consents[key] = !next; }
  }
  const lim = $derived(status.limits || {});
  const usePct = (b) => (b && typeof b.pct === 'number' ? Math.max(0, Math.min(100, Math.round(b.pct))) : null);
  function resetIn(b) {
    const s = b?.resetsAt ? Math.round((b.resetsAt - Date.now()) / 1000) : 0;
    if (s <= 0) return '';
    if (s < 3600) return t('{n} 分钟后重置', { n: Math.max(1, Math.round(s / 60)) });
    if (s < 86400) return t('{n} 小时后重置', { n: Math.round(s / 3600) });
    return t('{n} 天后重置', { n: Math.round(s / 86400) });
  }

  // 登录表单（未登录时账户页的内容）：login | register | token | qr
  let lgMode = $state('login');
  let lgUser = $state(''), lgPass = $state(''), lgPass2 = $state(''), lgInvite = $state(''), lgTok = $state('');
  let lgBusy = $state(false), lgErr = $state('');
  let recents = $state(recentUsers());
  function lgSwitch(m) { lgMode = m; lgErr = ''; }
  function lgReset() { lgUser = ''; lgPass = ''; lgPass2 = ''; lgInvite = ''; lgTok = ''; lgErr = ''; lgMode = 'login'; }
  async function lgSubmit(e) {
    e?.preventDefault?.();
    if (lgBusy) return;
    lgBusy = true; lgErr = '';
    try {
      if (lgMode === 'register') await signUp({ username: lgUser.trim(), password: lgPass, password2: lgPass2, invite: lgInvite.trim() });
      else if (lgMode === 'token') await signInToken(lgTok);
      else await signIn(lgUser.trim(), lgPass);
      lgReset(); recents = recentUsers();
    } catch (err) {
      lgErr = tr(err?.body?.error) || (lgMode === 'register' ? t('注册失败') : lgMode === 'token' ? t('令牌无效') : t('登录失败'));
    }
    lgBusy = false;
  }
  function pickRecent(name) { lgMode = 'login'; lgUser = name; lgPass = ''; lgErr = ''; setTimeout(() => document.querySelector('.settings .lg-pass input')?.focus(), 30); }
  function dropRecent(name) { forgetUser(name); recents = recentUsers(); }
  // 这台设备上保存着登录的账号（lib/accountVault.js）：点一下直接切换（换令牌整页重载），不退出、不重输密码
  let accts = $state([]);
  const refreshAccts = () => { accts = savedAccounts(); };
  $effect(() => { if (acctOpen) { void me.kind; refreshAccts(); } });
  // 最近登录的名字里去掉保险箱里已有的号（那些点一下就进，不必再填密码）
  const recentsShown = $derived(recents.filter((n) => !accts.some((a) => a.kind === 'user' && a.user === n)));
  let switching = $state('');   // 正在切过去的账号键
  let acctErr = $state('');
  async function doSwitch(a) {
    if (a.current || switching) return;
    switching = a.key; acctErr = ''; lgErr = '';
    try { await switchTo(a.key); }
    catch (e) {
      switching = '';
      if (e?.expired) {
        // 那张登录已失效：落到登录表单（当前号收进保险箱、不吊销），账号名填好，只差密码
        if (me.kind !== 'none') await parkCurrent();
        refreshAccts(); recents = recentUsers();
        lgReset();
        if (e.user) pickRecent(e.user);
        lgErr = e.user ? t('{name} 的登录已失效，请重新输入密码。', { name: e.user }) : t('这个账号的登录已失效，请重新登录。');
      } else acctErr = t('连不上服务器，稍后再试');
    }
  }
  async function addSignIn() {
    if (switching) return;
    await parkCurrent();
    mine = null; pwc.done = false;
    lgReset(); recents = recentUsers(); refreshAccts();
  }
  async function dropAcct(a) { await forgetAccount(a.key); refreshAccts(); }
  // 扫码登录（网页端出码、手机扫）：进 qr 模式即领票出码 + 长轮询，离开即停（两套外壳共用，lib/settings/common.svelte.js）
  const pairing = createPairLogin(() => acctOpen && me.kind === 'none' && lgMode === 'qr', () => lgReset());

  // 改密码（注册用户）：表单页（状态与保存两套外壳共用）
  const pwc = createPasswordChange();
  // 退出登录先确认（真吊销这台设备上的这张会话、从保险箱删掉）；切换账号在上面的账号列表里，点一下就换、不用确认。
  let acctAsk = $state(null);   // null | 'logout'
  let acctBusy = $state(false);
  async function acctConfirm() {
    if (acctBusy) return;
    acctBusy = true;
    await signOut();
    acctBusy = false; acctAsk = null; mine = null; pwc.done = false;
    lgReset(); recents = recentUsers(); refreshAccts();
    // 回设置根页（账户卡变成「登录」）；保险箱里还有别的号就留在这一页，点一下切过去
    if (!accts.length && S.nav.stack.length > 1) S.nav.pop();
  }
  function openWorkspaceFromAcct() { ui.settingsOpen = false; ui.screen = 'files'; }
  function openScanFromAcct() { ui.pairScan = { mode: 'scan' }; }   // 全屏取景层（z 400）盖在设置上，扫完回到这里
  return {
    get roleLabel() { return roleLabel; }, get shownName() { return shownName; }, get initial() { return initial; }, canScan,
    get mine() { return mine; }, get aa() { return aa; }, toggleAa, get lim() { return lim; }, usePct, resetIn,
    get lgMode() { return lgMode; },
    get lgUser() { return lgUser; }, set lgUser(v) { lgUser = v; }, get lgPass() { return lgPass; }, set lgPass(v) { lgPass = v; },
    get lgPass2() { return lgPass2; }, set lgPass2(v) { lgPass2 = v; }, get lgInvite() { return lgInvite; }, set lgInvite(v) { lgInvite = v; },
    get lgTok() { return lgTok; }, set lgTok(v) { lgTok = v; },
    get lgBusy() { return lgBusy; }, get lgErr() { return lgErr; }, lgSwitch, lgSubmit, pickRecent, dropRecent,
    get accts() { return accts; }, get recentsShown() { return recentsShown; }, get switching() { return switching; }, get acctErr() { return acctErr; },
    doSwitch, addSignIn, dropAcct,
    get pair() { return pairing.pair; }, get pairCtl() { return pairing.pairCtl; }, get pairMsg() { return pairing.pairMsg; },
    get pw() { return pwc.form; }, set pw(v) { pwc.form = v; }, get pwDone() { return pwc.done; }, set pwDone(v) { pwc.done = v; }, savePw: () => pwc.save(),
    get acctAsk() { return acctAsk; }, set acctAsk(v) { acctAsk = v; }, get acctBusy() { return acctBusy; }, acctConfirm,
    openWorkspaceFromAcct, openScanFromAcct,
  };
}
