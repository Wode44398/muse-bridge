<script>
  // 「给别人用」+ 隔离等级说明 + 待确认的 Pro 账号。挂在「用户」页最上面。
  // 数据面 /api/admin/access（routes/admin-accounts.mjs）。Muse 上单人 / 多人由 bootstrap.sh set-users 管（界面改了会被下次
  // install / update 覆盖），所以这里只读显示现状，并提示在 Muse 里说一句来切换；不摆写 features.multiUser 的开关。
  import { api } from '../../lib/api.js';
  import { sa, saToast, saConfirm, loadUsers } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  let st = $state(null);   // { multiUser, next, pendingRestart, saved, deploy, isolation, trustPending, supervisor }

  async function load() { try { st = await api.get('/api/admin/access'); } catch { st = null; } }
  $effect(() => { sa.tick; load(); });

  const win = $derived(st?.isolation?.platform === 'win32');
  const inContainer = $derived(!!st?.isolation?.container);
  // 待确认名单跟着用户列表走（改名 / 降档 / 删除后 loadUsers 一刷新这里就变）；列表还没拉到时用接口带的
  const pending = $derived(sa.users.length ? sa.users.filter((u) => u.trustPending).map((u) => ({ id: u.id || u.name, name: u.name })) : (st?.trustPending || []));
  // 升级前发的、还没用的 Pro 码：不过期、发的时候也没确认过「等同管理员」，谁拿到都能注册出有命令行的账号
  const oldCodes = $derived((sa.invites || []).filter((i) => i.legacyFull));
  const LEVEL = { L1: t('逻辑隔离'), L2: t('进程隔离'), L3: t('容器隔离') };

  async function ackAll() {
    const list = pending;
    if (!list.length) return;
    if (!(await saConfirm(
      t('全部确认保留 Pro？'),
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
      t('作废这些老的 Pro 邀请码？'),
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
            {#if st.multiUser}
              {t('开着：可以发邀请码、让别人注册；每人有自己的目录和对话')}
            {:else}
              {t('关着：只有你（访问令牌 / 扫码）和服务账号能登录')}
            {/if}
          </small>
          <small>{t('要切换，在 Muse 里说「改成多人用」或「改成自己用」。')}</small>
        </span>
        <span class="sa-badge {st.multiUser ? 'green' : 'gray'}">{st.multiUser ? t('多用户') : t('单人')}</span>
      </div>
      <div class="sa-row iso">
        <span class="sa-row-tx">
          <span>{t('隔离等级：{level}', { level: (st.isolation?.level || 'L1') + ' ' + (LEVEL[st.isolation?.level] || LEVEL.L1) })}</span>
          <small>{t('普通档：没有命令行，Claude 只能在他自己的目录里读写，看不到别人的对话和文件——可以放心发。')}</small>
          <small class="warn">{t('Pro 档：有命令行和终端，跑在服务端同一个系统账户下，能读到服务器上所有人的对话、文件和全部凭据（Claude 登录凭据、各家 API Key），等同管理员——只给你完全信任的人。')}</small>
          <small>
            {#if win}{t('原生 Windows 只能做到逻辑隔离；进程隔离、容器隔离（Linux）还没接入，接入后 Pro 档才会被关进沙箱。')}
            {:else if inContainer}{t('进程隔离、容器隔离还没接入：现在的 Docker 镜像里所有成员也是同一个系统用户，只把成员和宿主隔开了。')}
            {:else}{t('进程隔离、容器隔离还没接入：所有成员和服务端跑在同一个系统账户下，彼此之间只有逻辑隔离。')}{/if}
          </small>
        </span>
      </div>
    </div>
  </div>

  {#if pending.length || oldCodes.length}
    <div class="sa-card pend">
      <div class="sa-card-h">{pending.length ? t('待确认的 Pro 账号') : t('升级前发的 Pro 邀请码')}</div>
      <div class="sa-rows">
        {#if pending.length}
          <div class="sa-row">
            <span class="sa-row-tx">
              <span>{pending.map((u) => u.name).join('、')}</span>
              <small>{t('这些 Pro 账号是升级前开的，还没确认过「等同管理员」，不会自动降级。逐个确认保留，或在「管理」里降为普通。')}</small>
            </span>
            <button class="sa-btn sm" onclick={ackAll}>{t('全部确认')}</button>
          </div>
        {/if}
        {#if oldCodes.length}
          <div class="sa-row">
            <span class="sa-row-tx">
              <span>{t('还有 {n} 张升级前发的 Pro 邀请码没用', { n: oldCodes.length })}</span>
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
  .iso .sa-row-tx { gap: 4px; }
  .iso small { line-height: 1.5; }
  .iso small.warn { color: #ffb340; }
  .pend { margin-top: 12px; box-shadow: inset 0 0 0 1px rgba(255, 179, 64, .35); }
</style>
