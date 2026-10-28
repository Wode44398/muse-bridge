<script>
  // 「给别人用」（开源路线 S2-3）+ 隔离等级说明（S2-2）+ 待确认的完全信任账号（N12）。挂在「用户」页最上面。
  // 数据面 /api/admin/access（routes/admin-accounts.mjs）：开关写进 config.json 的 features.multiUser，
  // 与安装时选的「给谁用」是同一个设置；重启服务端后生效（启动时冻结，运行中切换会让一半的接口看到旧值）。
  // 部署方接管时（服务端带 managed:{ hint }，如 Muse Bridge 由部署脚本管多人 / 单人）只读：开关换成徽标 + 部署方给的那句话。
  import { api } from '../../lib/api.js';
  import { managedHint } from '../../lib/deployFlags.js';
  import { sa, saToast, saConfirm, loadUsers } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let st = $state(null);   // { multiUser, next, pendingRestart, saved, deploy, isolation, trustPending, supervisor, managed }
  let busy = $state(false);

  async function load() { try { st = await api.get('/api/admin/access'); } catch { st = null; } }
  $effect(() => { sa.tick; load(); });

  const managed = $derived(managedHint(st));
  const win = $derived(st?.isolation?.platform === 'win32');
  const inContainer = $derived(!!st?.isolation?.container);
  // 待确认名单跟着用户列表走（改名 / 降档 / 删除后 loadUsers 一刷新这里就变）；列表还没拉到时用接口带的
  const pending = $derived(sa.users.length ? sa.users.filter((u) => u.trustPending).map((u) => ({ id: u.id || u.name, name: u.name })) : (st?.trustPending || []));
  // 升级前发的、还没用的完全信任（Pro）码：不过期、发的时候也没确认过「等同管理员」，谁拿到都能注册出有命令行的账号
  const oldCodes = $derived((sa.invites || []).filter((i) => i.legacyFull));
  const LEVEL = { L1: t('逻辑隔离'), L2: t('进程隔离'), L3: t('容器隔离') };

  async function toggle() {
    if (!st || busy || managed) return;
    const on = !st.next;
    if (on && !(await saConfirm(
      t('开放给其他人使用？'),
      t('打开后可以发邀请码、让别人注册账号。每人有自己的目录和对话，但这台服务端只有「逻辑隔离」：普通档（没有命令行）的人彼此看不到；完全信任档的人能读到服务器上所有人的数据和全部凭据，等同管理员。邀请码默认只发普通档。重启服务端后生效。'),
      { yes: t('打开多用户') },
    ))) return;
    if (!on && !(await saConfirm(
      t('只给自己用？'),
      t('关掉后普通账号都登不上了（服务账号除外），已有账号和数据都保留，以后再打开就恢复。重启服务端后生效。'),
      { yes: t('关掉'), danger: true },
    ))) return;
    busy = true;
    try {
      const r = await api.post('/api/admin/access', { multiUser: on });
      if (r?.error) throw new Error(r.error);
      st = r;
      saToast(r.pendingRestart ? t('已保存，重启服务端后生效') : t('已保存'));
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('保存失败'), true); }
    busy = false;
  }

  async function restartIdle() {
    try {
      const r = await api.post('/api/admin/service/restart', { mode: 'idle' });
      if (r?.error) throw new Error(r.error);
      saToast(r.restart?.pending ? t('会在 {n} 轮对话跑完后重启', { n: r.live || '' }) : t('正在重启…'));
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('重启失败'), true); }
  }

  async function ackAll() {
    const list = pending;
    if (!list.length) return;
    if (!(await saConfirm(
      t('全部确认保留完全信任？'),
      t('{names} 会继续有命令行，能读到服务器上所有人的数据和全部凭据。只确认你完全信任的人；不确定的，在下面他的「管理」里降为普通。', { names: list.map((u) => u.name).join('、') }),
      { yes: t('全部确认') },
    ))) return;
    for (const u of list) { try { await api.post('/api/admin/user/trust-ack', { name: u.id }); } catch {} }
    saToast(t('已确认'));
    load(); loadUsers();
  }

  async function revokeOldCodes() {
    const list = oldCodes;
    if (!list.length) return;
    if (!(await saConfirm(
      t('作废这些老的完全信任邀请码？'),
      t('作废后这 {n} 张码就不能再注册了；已经用它们注册的账号不受影响。要给人发码，重新生成（新码 7 天内有效、默认普通档）。', { n: list.length }),
      { yes: t('全部作废'), danger: true },
    ))) return;
    let bad = 0;
    for (const i of list) { try { const r = await api.post('/api/admin/invite/revoke', { code: i.code }); if (r?.error) bad++; } catch { bad++; } }
    saToast(bad ? t('有 {n} 张没作废成功', { n: bad }) : t('已作废'), !!bad);
    loadUsers();
  }
</script>

{#if st}
  <div class="sa-card">
    <div class="sa-card-h">{t('给别人用')}</div>
    <div class="sa-rows">
      <div class="sa-row">
        <span class="sa-row-tx">
          <span>{t('开放给其他人使用（多用户）')}</span>
          <small>
            {#if st.pendingRestart}
              {st.next ? t('已打开，重启服务端后生效') : t('已关闭，重启服务端后生效')}
            {:else if st.multiUser}
              {t('开着：可以发邀请码、让别人注册；每人有自己的目录和对话')}
            {:else}
              {t('关着：只有你（访问令牌 / 扫码）和服务账号能登录')}
            {/if}
          </small>
          {#if managed}<small>{tr(managed)}</small>{/if}
        </span>
        {#if managed}
          <span class="sa-badge {st.multiUser ? 'green' : 'gray'}">{st.multiUser ? t('多用户') : t('单人')}</span>
        {:else}
          <button class="sa-sw" class:on={st.next} disabled={busy} onclick={toggle} aria-label={t('开放给其他人使用（多用户）')}><span class="sa-sw-knob"></span></button>
        {/if}
      </div>
      {#if st.pendingRestart}
        <div class="sa-row">
          <span class="sa-row-tx">
            <span>{t('重启服务端')}</span>
            <small>{st.supervisor ? t('等没有在跑的对话时自动重启（最多等 30 分钟）') : t('这台服务端没有守护进程托管：请在托盘里重启本机服务端，或在服务器上手动重启')}</small>
          </span>
          {#if st.supervisor}<button class="sa-btn sm" onclick={restartIdle}>{t('空闲时重启')}</button>{/if}
        </div>
      {/if}
      <div class="sa-row iso">
        <span class="sa-row-tx">
          <span>{t('隔离等级：{level}', { level: (st.isolation?.level || 'L1') + ' ' + (LEVEL[st.isolation?.level] || LEVEL.L1) })}</span>
          <small>{t('普通档：没有命令行，Claude 只能在他自己的目录里读写，看不到别人的对话和文件——可以放心发。')}</small>
          <small class="warn">{t('完全信任档：有命令行、终端和浏览器，跑在服务端同一个系统账户下，能读到服务器上所有人的对话、文件和全部凭据（号池令牌、各家 API Key），等同管理员——只给你完全信任的人。')}</small>
          <small>
            {#if win}{t('原生 Windows 只能做到逻辑隔离；进程隔离、容器隔离（Linux）还没接入，接入后完全信任档才会被关进沙箱。')}
            {:else if inContainer}{t('进程隔离、容器隔离还没接入：现在的 Docker 镜像里所有成员也是同一个系统用户，只把成员和宿主隔开了。')}
            {:else}{t('进程隔离、容器隔离还没接入：所有成员和服务端跑在同一个系统账户下，彼此之间只有逻辑隔离。')}{/if}
          </small>
        </span>
      </div>
    </div>
  </div>

  {#if pending.length || oldCodes.length}
    <div class="sa-card pend">
      <div class="sa-card-h">{pending.length ? t('待确认的完全信任账号') : t('升级前发的完全信任邀请码')}</div>
      <div class="sa-rows">
        {#if pending.length}
          <div class="sa-row">
            <span class="sa-row-tx">
              <span>{pending.map((u) => u.name).join('、')}</span>
              <small>{t('这些账号是改名「完全信任」之前开的（Pro 档或没写档位），不会自动降级。逐个确认保留，或在「管理」里降为普通。')}</small>
            </span>
            <button class="sa-btn sm" onclick={ackAll}>{t('全部确认')}</button>
          </div>
        {/if}
        {#if oldCodes.length}
          <div class="sa-row">
            <span class="sa-row-tx">
              <span>{t('还有 {n} 张升级前发的完全信任邀请码没用', { n: oldCodes.length })}</span>
              <small>{t('这些码不会过期，发的时候也没经过「等同管理员」的确认：谁拿到都能注册出有命令行、能读到所有人数据和凭据的账号。不再需要就作废。')}</small>
            </span>
            <button class="sa-btn sm dgr" onclick={revokeOldCodes}>{t('全部作废')}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  <div style="height:12px"></div>
{/if}

<style>
  .sa-sw:disabled { opacity: .4; cursor: default; }
  .iso .sa-row-tx { gap: 4px; }
  .iso small { line-height: 1.5; }
  .iso small.warn { color: var(--sa-warn); }
  .pend { margin-top: 12px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sa-warn) 40%, transparent); }
</style>
