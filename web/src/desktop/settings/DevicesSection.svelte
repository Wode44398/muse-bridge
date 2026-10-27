<script>
  // 设置 · 设备（桌面壳）：这台电脑的档位 · 我的设备 · 端口转发。
  // 「设备」= 登记到这个账号的电脑：Claude 跑在服务器上，经设备通道看它的屏幕、操作它、开它的终端、
  // 转发它的本机端口。数据面 lib/devices.svelte.js（手机设置、单页设置共用），后端 routes/devices.mjs。
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import { t, tc, tr } from '../../lib/i18n.js';
  import {
    devices, loadDevices, thisDeviceId, renameDevice, revokeDevice, deleteDevice, stopDevice,
    deviceStatusLine, forwards, loadForwards, addForward, dropForward, forwardShareUrl,
    thisComputer, setThisComputerMode, stopThisComputer,
  } from '../../lib/devices.svelte.js';

  let { fl = () => false } = $props();   // 设置搜索跳转后的高亮

  loadDevices(true);
  loadForwards();

  const me = thisDeviceId();
  let openId = $state('');
  let nameDraft = $state('');
  let busy = $state('');
  let err = $state('');
  let note = $state('');
  let fwdDevice = $state('');
  let fwdPort = $state('');
  let fwdLabel = $state('');

  const TIERS = [{ value: 'off', label: tc('开关', '关') }, { value: 'observe', label: t('只看') }, { value: 'control', label: t('操作') }];
  const thisSub = $derived.by(() => {
    const d = thisComputer.device;
    if (thisComputer.active) return t('进行中 · {action}', { action: tr(thisComputer.lastAction || thisComputer.source || '') });
    if (thisComputer.mode === 'off') return t('已关闭：服务器上看这台电脑是离线');
    if (d && d.connected) return thisComputer.mode === 'control' ? t('已连上服务器 · Claude 可以操作这台电脑') : t('已连上服务器 · Claude 只能看，动手前先问你');
    if (d && d.error) return t('没连上：{err}', { err: d.error });
    return t('正在连接服务器…');
  });
  const thisFoot = $derived(thisComputer.shortcut
    ? t('被操作时屏幕上方有提示条，随时可急停或按 {shortcut}。档位由这台电脑自己把关，服务器改不了。', { shortcut: thisComputer.shortcut })
    : t('被操作时屏幕上方有提示条，随时可急停。档位由这台电脑自己把关，服务器改不了。'));

  const fwdChoices = $derived(devices.list.filter((d) => !d.revoked && (d.client?.caps || []).includes('http')).map((d) => ({ value: d.id, label: d.name })));
  $effect(() => { if (!fwdDevice && fwdChoices.length) fwdDevice = (fwdChoices.find((o) => o.value === me) || fwdChoices[0]).value; });

  const meta = (d) => [deviceStatusLine(d, t), d.client?.version ? 'v' + d.client.version : '', d.sameMachine ? t('与服务器是同一台') : '']
    .filter(Boolean).join(' · ');

  async function run(key, fn, okNote = '') {
    busy = key; err = ''; note = '';
    try { await fn(); if (okNote) note = okNote; } catch (e) { err = String(e?.message || e); }
    finally { busy = ''; }
  }
  function toggle(d) {
    openId = openId === d.id ? '' : d.id;
    nameDraft = d.name;
  }
  const saveName = (d) => run('name:' + d.id, () => renameDevice(d.id, nameDraft.trim()), t('已改名'));
  const stop = (d) => run('stop:' + d.id, () => stopDevice(d.id), t('已断开，客户端会自动重连'));
  const revoke = (d) => run('revoke:' + d.id, () => revokeDevice(d.id), t('已吊销：那台电脑要重新登录才能再连上'));
  const remove = (d) => run('delete:' + d.id, async () => { await deleteDevice(d.id); openId = ''; }, t('已删除'));

  const addFwd = () => run('fwd', async () => {
    const port = Number(fwdPort);
    if (!fwdDevice) throw new Error(t('先选一台电脑'));
    if (!(port >= 1 && port <= 65535)) throw new Error(t('端口要在 1-65535 之间'));
    await addForward(fwdDevice, port, fwdLabel.trim());
    fwdPort = ''; fwdLabel = '';
  }, t('已接通'));
  const delFwd = (f) => run('fwd:' + f.token, () => dropForward(f.token), t('已删除，地址立即失效'));
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); note = t('已复制'); err = ''; } catch { err = t('复制失败'); }
  }

</script>

{#if err}<p class="dv-msg err sel-text">{err}</p>{:else if note}<p class="dv-msg">{note}</p>{/if}

{#if thisComputer.supported}
  <DGroup label={t('这台电脑')} foot={thisFoot}>
    <DRow title={t('Claude 能用这台电脑吗')} sub={thisSub} highlight={fl('dv-tier')}>
      {#snippet trailing()}<DSegmented options={TIERS} value={thisComputer.mode} onchange={setThisComputerMode} />{/snippet}
    </DRow>
    {#if thisComputer.active}
      <DRow title={t('立即停止本轮操作')} danger chevron={false} onclick={stopThisComputer} />
    {/if}
  </DGroup>
{/if}

<DGroup label={t('我的设备')} foot={t('在电脑上装 bridge 桌面客户端并用同一个账号登录，它就会出现在这里。吊销后那台电脑立刻断开，要重新登录才能再连。')}>
  {#if !devices.loaded}
    <DRow title={t('正在读取…')} />
  {:else if !devices.list.length}
    <DRow title={t('还没有设备')} sub={t('登录后这台电脑会自动出现在这里')} />
  {:else}
    {#each devices.list as d (d.id)}
      <DRow title={d.name + (d.id === me ? ' · ' + t('这台') : '')} sub={meta(d)} highlight={fl('dv-' + d.id)} onclick={() => toggle(d)} />
      {#if openId === d.id}
        <DRow title={t('名字')}>
          {#snippet trailing()}
            <span class="dv-inline">
              <DField bind:value={nameDraft} width="180px" />
              <DButton size="sm" disabled={busy === 'name:' + d.id || !nameDraft.trim() || nameDraft.trim() === d.name} onclick={() => saveName(d)}>{t('保存')}</DButton>
            </span>
          {/snippet}
        </DRow>
        <DRow title={d.hostname ? t('主机名 {host}', { host: d.hostname }) : t('设备')} sub={[d.client?.os, d.platform, d.id].filter(Boolean).join(' · ')} subSelectable>
          {#snippet trailing()}
            <span class="dv-inline">
              {#if d.online}<DButton size="sm" disabled={busy === 'stop:' + d.id} onclick={() => stop(d)}>{t('断开')}</DButton>{/if}
              {#if !d.revoked}
                <DButton size="sm" variant="danger" disabled={busy === 'revoke:' + d.id} onclick={() => revoke(d)}>{t('吊销')}</DButton>
              {:else}
                <DButton size="sm" variant="danger" disabled={busy === 'delete:' + d.id} onclick={() => remove(d)}>{t('删除')}</DButton>
              {/if}
            </span>
          {/snippet}
        </DRow>
      {/if}
    {/each}
  {/if}
</DGroup>

<DGroup label={t('端口转发')} foot={forwards.previewDomain
  ? t('把电脑上的本机端口（dev server、本机模型接口）接到服务器：手机上也能打开，Claude 也能用。持有地址的人都能访问，不用了就删掉。')
  : t('把电脑上的本机端口（dev server、本机模型接口）接到服务器：手机上也能打开，Claude 也能用。持有地址的人都能访问，不用了就删掉。网页应用要配预览域名（pvPublicDomain）才能完整显示。')}>
  {#each forwards.list as f (f.token)}
    <DRow title={(f.label ? f.label + ' · ' : '') + t('端口 {port}', { port: f.port })} sub={(f.deviceName ? f.deviceName + ' · ' : '') + forwardShareUrl(f)} subSelectable>
      {#snippet trailing()}
        <span class="dv-inline">
          <DButton size="sm" variant="ghost" onclick={() => copy(forwardShareUrl(f))}>{t('复制地址')}</DButton>
          <DButton size="sm" variant="ghost" onclick={() => window.open(forwardShareUrl(f), '_blank', 'noopener')}>{t('打开')}</DButton>
          <DButton size="sm" variant="danger" disabled={busy === 'fwd:' + f.token} onclick={() => delFwd(f)}>{t('删除')}</DButton>
        </span>
      {/snippet}
    </DRow>
  {/each}
  {#if fwdChoices.length}
    <DRow title={t('新的转发')} highlight={fl('dv-forward')}>
      {#snippet trailing()}
        <span class="dv-inline">
          <DSelect options={fwdChoices} bind:value={fwdDevice} width="150px" />
          <DField bind:value={fwdPort} placeholder={t('端口')} width="76px" />
          <DField bind:value={fwdLabel} placeholder={t('备注（可选）')} width="120px" />
          <DButton size="sm" variant="primary" disabled={busy === 'fwd' || !fwdPort} onclick={addFwd}>{t('接通')}</DButton>
        </span>
      {/snippet}
    </DRow>
  {:else}
    <DRow title={t('没有能转发端口的电脑')} sub={t('需要新版桌面客户端在线')} />
  {/if}
</DGroup>

<style>
  .dv-inline { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .dv-msg { margin: 0 0 10px; font-size: 12.5px; color: var(--dsk-text-2, var(--muted)); }
  .dv-msg.err { color: var(--dsk-red, #d4553a); }
</style>
