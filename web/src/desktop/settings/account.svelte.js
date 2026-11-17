// 桌面设置 › 账户（原主页右上登录胶囊收编于此）：登录 / 注册 / 令牌 / 扫码、额度、改密码、切换与退出。
import { untrack } from 'svelte';
import { ui, me, status } from '../../lib/state.svelte.js';
import { t, tr } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import { signIn, signUp, signInToken, signOut, savedAccounts, switchTo, parkCurrent, forgetAccount } from '../../lib/account.js';
import { fetchMyUsage } from '../../lib/me.js';
import { loadAuthProviders } from '../../lib/authProviders.svelte.js';
import { roleLabelOf } from '../../lib/settings/common.js';
import { createPairLogin, createPasswordChange } from '../../lib/settings/common.svelte.js';

export function createDeskAccount(D) {
  // ═══ 账户（原主页右上登录胶囊收编于此；登录逻辑与 LoginCard 同一套 api 语义）═══
  const roleLabel = $derived(roleLabelOf(me));   // 两套外壳共用（lib/settings/common.js；tier 'pro' = 「完全信任」档）
  const initial = $derived((me.user || 'A').trim().charAt(0).toUpperCase());
  let mode = $state('login'); // 'login' | 'register' | 'token'
  let lgUser = $state(''), lgPass = $state(''), lgPass2 = $state(''), lgInvite = $state(''), lgTok = $state('');
  let lgBusy = $state(false), lgErr = $state('');
  // 登录 / 注册 / 令牌 / 退出 / 切换都走 lib/account.js（与手机设置页同一套：存 Bearer、收进本机账号保险箱、换号整页重载）
  async function doLogin() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { await signIn(lgUser.trim(), lgPass); lgReset(); }
    catch (e) { lgErr = tr(e.body?.error) || t('登录失败'); }
    lgBusy = false;
  }
  async function doRegister() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { await signUp({ username: lgUser.trim(), password: lgPass, password2: lgPass2, invite: lgInvite.trim() }); lgReset(); }
    catch (e) { lgErr = tr(e.body?.error) || t('注册失败'); }
    lgBusy = false;
  }
  async function doToken() {
    if (lgBusy) return; lgBusy = true; lgErr = '';
    try { await signInToken(lgTok); lgReset(); }
    catch (e) { lgErr = tr(e.body?.error) || t('令牌无效'); }
    lgBusy = false;
  }
  // 这台设备上保存着登录的账号：「切换」直接换过去（整页重载），不退出、不重输密码
  let accts = $state([]);
  const refreshAccts = () => { accts = savedAccounts(); };
  $effect(() => { if (D.sec === 'account') { void me.kind; refreshAccts(); } });
  const acctRole = (a) => (a.kind === 'admin' ? t('管理员') : a.tier === 'pro' ? t('完全信任用户') : t('普通用户'));
  let switching = $state(''), acctErr = $state('');
  async function doSwitch(a) {
    if (a.current || switching) return;
    switching = a.key; acctErr = ''; lgErr = '';
    try { await switchTo(a.key); }
    catch (e) {
      switching = '';
      if (e?.expired) {
        if (me.kind !== 'none') await parkCurrent();
        refreshAccts(); lgReset(); mode = 'login';
        lgUser = e.user || '';
        lgErr = e.user ? t('{name} 的登录已失效，请重新输入密码。', { name: e.user }) : t('这个账号的登录已失效，请重新登录。');
      } else acctErr = t('连不上服务器，稍后再试');
    }
  }
  async function addSignIn() { if (switching) return; await parkCurrent(); lgReset(); mode = 'login'; refreshAccts(); }
  async function dropAcct(a) { await forgetAccount(a.key); refreshAccts(); }
  // —— 我的额度 / 改密码（注册用户；三端拆分 P4）——
  let myUsage = $state(null);
  $effect(() => { if (D.sec === 'account' && me.kind === 'user') fetchMyUsage().then((r) => { myUsage = r; }).catch(() => {}); });
  // 改密码：状态与保存两套外壳共用（lib/settings/common.svelte.js）
  const pwc = createPasswordChange();
  // 退出登录先确认（确认框在外壳的弹窗里）
  let logoutAsk = $state(false);
  async function doLogout() {
    logoutAsk = false;
    await signOut(); mode = 'login'; refreshAccts();
  }
  function lgReset() { lgUser = ''; lgPass = ''; lgPass2 = ''; lgInvite = ''; lgTok = ''; lgErr = ''; }
  // 登录页一露面就拉一次外部登录方式
  $effect(() => { if (D.sec === 'account' && me.kind === 'none') untrack(() => loadAuthProviders()); });
  // 扫码登录（与 LoginCard 同一套 lib/pair.js 状态机）：进 qr 模式即出码 + 长轮询，离开即停（两套外壳共用，lib/settings/common.svelte.js）
  const pairing = createPairLogin(() => D.sec === 'account' && me.kind === 'none' && mode === 'qr', () => { mode = 'login'; lgReset(); });
  function submitAuth(e) {
    e.preventDefault();
    if (mode === 'register') doRegister(); else if (mode === 'token') doToken(); else doLogin();
  }
  function openWorkspace() { ui.settingsOpen = false; ui.screen = 'files'; }
  // 进账户区且已登录 → 拉一次额度快照
  $effect(() => {
    if (D.sec !== 'account' || me.kind === 'none') return;
    api.status().then((s) => { status.limits = s.limits || null; status.context = s.context || null; status.updatedAt = Date.now(); }).catch(() => {});
  });
  const lim = $derived(status.limits || {});
  const fiveH = $derived(lim.five_hour ? Math.round(lim.five_hour.pct || 0) : null);
  const weekly = $derived(lim.seven_day ? Math.round(lim.seven_day.pct || 0) : null);
  return {
    get roleLabel() { return roleLabel; }, get initial() { return initial; },
    get mode() { return mode; }, set mode(v) { mode = v; },
    get lgUser() { return lgUser; }, set lgUser(v) { lgUser = v; }, get lgPass() { return lgPass; }, set lgPass(v) { lgPass = v; },
    get lgPass2() { return lgPass2; }, set lgPass2(v) { lgPass2 = v; }, get lgInvite() { return lgInvite; }, set lgInvite(v) { lgInvite = v; },
    get lgTok() { return lgTok; }, set lgTok(v) { lgTok = v; }, get lgBusy() { return lgBusy; }, get lgErr() { return lgErr; }, set lgErr(v) { lgErr = v; },
    get accts() { return accts; }, acctRole, get switching() { return switching; }, get acctErr() { return acctErr; }, doSwitch, addSignIn, dropAcct,
    get myUsage() { return myUsage; },
    get pwForm() { return pwc.form; }, set pwForm(v) { pwc.form = v; }, get pwOk() { return pwc.done; }, set pwOk(v) { pwc.done = v; }, savePw: pwc.save,
    get logoutAsk() { return logoutAsk; }, set logoutAsk(v) { logoutAsk = v; }, doLogout,
    get pair() { return pairing.pair; }, get pairCtl() { return pairing.pairCtl; }, get pairMsg() { return pairing.pairMsg; },
    submitAuth, openWorkspace, get lim() { return lim; }, get fiveH() { return fiveH; }, get weekly() { return weekly; },
  };
}
