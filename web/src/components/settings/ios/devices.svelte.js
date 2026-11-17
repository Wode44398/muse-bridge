// 设置 › 设备（我的电脑、端口转发）与 Agent 接入（iOS 外壳）。数据面 lib/devices.svelte.js、lib/agentKeys.svelte.js，与桌面设置同源。
import { untrack } from 'svelte';
import { me, pluginOn } from '../../../lib/state.svelte.js';
import { t, tc } from '../../../lib/i18n.js';
import {
  devices, loadDevices, thisDeviceId, renameDevice, revokeDevice, deleteDevice, stopDevice,
  addForward, dropForward, thisComputer,
} from '../../../lib/devices.svelte.js';
import { agentKeys, watchAgentKeys, createAgentKey, revokeAgentKey, copyText, fmtKeyDay } from '../../../lib/agentKeys.svelte.js';
import { relTime } from '../../../lib/format.js';

export function createDevices(S) {
  // —— 设备：我的电脑（Claude 经设备通道操作它）、端口转发 ——
  // 设备是账号级的，手机上也能管；「这台电脑」的档位只在桌面客户端里出现（thisComputer.supported）。
  // 数据面 lib/devices.svelte.js，与桌面设置（DevicesSection）同源。
  const hasDevices = $derived(me.kind === 'admin' || me.kind === 'user');
  // 根页上按内置功能（插件）显隐的几行：设置 › 扩展 › 功能扩展里关掉就不出现
  const phoneRow = $derived(S.phone.hasPhoneCtrl && pluginOn('phone-control'));
  const devRow = $derived(hasDevices && pluginOn('devices'));
  const myDeviceId = thisDeviceId();
  let dvErr = $state('');
  let dvNote = $state('');
  let dvBusy = $state('');
  let dvName = $state('');
  let dvFwdDevice = $state('');
  let dvFwdPort = $state('');
  let dvFwdLabel = $state('');
  $effect(() => { if (hasDevices && !devices.loaded) loadDevices(); });
  const dvOnline = $derived(devices.list.filter((d) => d.online).length);
  const dvFwdChoices = $derived(devices.list.filter((d) => !d.revoked && (d.client?.caps || []).includes('http')).map((d) => ({ value: d.id, label: d.name })));
  const DV_TIERS = [
    { value: 'off', label: tc('开关', '关闭'), sub: t('服务器上看这台电脑是离线') },
    { value: 'observe', label: t('只看'), sub: t('能看屏幕、读界面；动手前先问你') },
    { value: 'control', label: t('操作'), sub: t('能点键鼠、跑命令、读写文件') },
  ];
  const dvThisFoot = $derived.by(() => {
    const d = thisComputer.device;
    const conn = thisComputer.mode === 'off' ? '' : d && d.connected ? t('已连上服务器。') : d && d.error ? t('没连上：{err}', { err: d.error }) + ' ' : t('正在连接服务器…') + ' ';
    return conn + (thisComputer.shortcut
      ? t('被操作时屏幕上方有提示条，随时可急停或按 {shortcut}。档位由这台电脑自己把关，服务器改不了。', { shortcut: thisComputer.shortcut })
      : t('被操作时屏幕上方有提示条，随时可急停。档位由这台电脑自己把关，服务器改不了。'));
  });
  async function dvRun(key, fn, okNote = '') {
    dvBusy = key; dvErr = ''; dvNote = '';
    try { await fn(); if (okNote) dvNote = okNote; return true; } catch (e) { dvErr = String(e?.message || e); return false; }
    finally { dvBusy = ''; }
  }
  // 设备与端口转发的拉取挂在「设备」页本身（见 stack 下面那个 effect），不挂在这一行的点击上
  function openDevices() { dvErr = ''; dvNote = ''; S.nav.go('devices'); }
  function openDevice(d) { dvName = d.name; dvErr = ''; dvNote = ''; S.nav.push('device:' + d.id); }
  function openFwdNew() {
    dvErr = ''; dvFwdPort = ''; dvFwdLabel = '';
    if (!dvFwdChoices.some((o) => o.value === dvFwdDevice)) dvFwdDevice = (dvFwdChoices.find((o) => o.value === myDeviceId) || dvFwdChoices[0] || {}).value || '';
    S.nav.push('fwd-new');
  }
  async function copyDv(text) {
    try { await navigator.clipboard.writeText(text); dvNote = t('已复制'); dvErr = ''; } catch { dvErr = t('复制失败'); }
  }
  const renameDv = (d) => dvRun('name', () => renameDevice(d.id, dvName.trim()), t('已改名'));
  const stopDv = (d) => dvRun('stop', () => stopDevice(d.id), t('已断开，客户端会自动重连'));
  const revokeDv = (d) => dvRun('revoke', () => revokeDevice(d.id), t('已吊销：那台电脑要重新登录才能再连上'));
  async function deleteDv(d) { if (await dvRun('delete', () => deleteDevice(d.id), t('已删除'))) S.nav.pop(); }
  const dropFwdDv = (f) => dvRun('fwd:' + f.token, () => dropForward(f.token), t('已删除，地址立即失效'));
  async function addFwdDv() {
    const ok = await dvRun('fwd', async () => {
      const port = Number(dvFwdPort);
      if (!dvFwdDevice) throw new Error(t('先选一台电脑'));
      if (!(port >= 1 && port <= 65535)) throw new Error(t('端口要在 1-65535 之间'));
      await addForward(dvFwdDevice, port, dvFwdLabel.trim());
    }, t('已接通'));
    if (ok) S.nav.pop();
  }
  return {
    get hasDevices() { return hasDevices; }, get phoneRow() { return phoneRow; }, get devRow() { return devRow; }, myDeviceId,
    get dvErr() { return dvErr; }, get dvNote() { return dvNote; }, get dvBusy() { return dvBusy; },
    get dvName() { return dvName; }, set dvName(v) { dvName = v; },
    get dvFwdDevice() { return dvFwdDevice; }, set dvFwdDevice(v) { dvFwdDevice = v; },
    get dvFwdPort() { return dvFwdPort; }, set dvFwdPort(v) { dvFwdPort = v; },
    get dvFwdLabel() { return dvFwdLabel; }, set dvFwdLabel(v) { dvFwdLabel = v; },
    get dvOnline() { return dvOnline; }, get dvFwdChoices() { return dvFwdChoices; }, DV_TIERS, get dvThisFoot() { return dvThisFoot; },
    openDevices, openDevice, openFwdNew, copyDv, renameDv, stopDv, revokeDv, deleteDv, dropFwdDv, addFwdDv,
  };
}

export function createAgentKeys(S) {
  // 「Agent 接入」页露面期间拉密钥列表、听总线 agent.keys；退出这一页就丢掉没看完的明文密钥
  const akOpen = $derived(S.nav.stack.includes('agentapi'));
  $effect(() => { if (akOpen) return untrack(() => watchAgentKeys()); });
  let akLabel = $state('');
  let akAsk = $state('');
  let akNote = $state('');
  let akNoteTimer = 0;
  function akFlash(text) { akNote = text; clearTimeout(akNoteTimer); akNoteTimer = setTimeout(() => { akNote = ''; }, 1800); }
  async function akCopy(text, okText = t('已复制')) { akFlash((await copyText(text)) ? okText : t('复制失败')); }
  async function akCreate() { if (akLabel.trim() && !agentKeys.busy && await createAgentKey(akLabel)) akLabel = ''; }
  async function akRevoke(id) { akAsk = ''; if (await revokeAgentKey(id)) akFlash(t('已吊销，用这把密钥的 agent 立刻失去访问')); }
  const akMeta = (k) => [
    t('创建于 {date}', { date: fmtKeyDay(k.created) }),
    k.seen ? t('最近使用 {when}', { when: relTime(k.seen) }) : t('还没用过'),
    k.expiresAt ? t('{date} 到期', { date: fmtKeyDay(k.expiresAt) }) : '',
  ].filter(Boolean).join(' · ');
  return {
    get akLabel() { return akLabel; }, set akLabel(v) { akLabel = v; }, get akAsk() { return akAsk; }, set akAsk(v) { akAsk = v; },
    get akNote() { return akNote; }, akCopy, akCreate, akRevoke, akMeta,
  };
}
