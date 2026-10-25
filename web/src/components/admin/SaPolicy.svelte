<script>
  // 额度与注册（三端拆分 P4；开源路线 S2-6 扩充）：注册开不开、注册用户的默认额度（轮数 / 花费 / 媒体 / 视频）、
  // 全服与每人同时最多几轮、每人最多几条定时任务、成员能不能用高消耗功能、「每天」按哪个时区换日。
  // 数据面 /api/admin/policy（存 config.json 的 policy 键，即时生效）。个人额度在「用户」页按人覆盖。
  // 额度只算 Claude：共享的是 Claude 订阅；dimensio 不计。管理员不受限。
  import { api } from '../../lib/api.js';
  import { sa, saToast, saConfirm, loadUsers } from '../../lib/serverAdmin.svelte.js';
  import { costNote } from '../../lib/me.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  let p = $state(null);               // { register, quota:{...}, maxUserTurns, maxParallelPerUser, maxRoutinesPerUser, member:{...}, timezone }
  let regOpen = $state(false);
  let form = $state({ dayTurns: '', weekTurns: '', dayCostUsd: '', weekCostUsd: '', maxUserTurns: '', maxParallelPerUser: '', maxRoutinesPerUser: '', timezone: '' });
  let busy = $state(false);

  const FIELDS = [
    { k: 'dayTurns', label: t('每天最多几轮'), unit: tc('admin', '轮'), step: 1 },
    { k: 'weekTurns', label: t('最近 7 天最多几轮'), unit: tc('admin', '轮'), step: 1 },
    { k: 'dayCostUsd', label: t('每天最多花多少'), unit: t('美元'), step: 0.5 },
    { k: 'weekCostUsd', label: t('最近 7 天最多花多少'), unit: t('美元'), step: 1 },
  ];
  // 成员（注册用户，服务账号除外）能不能用这些高消耗功能。
  const MEMBER_FEATS = [
    { k: 'fast', label: t('快速模式（fast）'), sub: t('同样的回答更快出来，但按更高的价格计用量') },
    { k: 'ultracode', label: 'Ultracode', sub: t('常驻动态工作流，一轮会派一群子 agent，用量成倍增加；关着时降到 Extra') },
    { k: 'ctx1m', label: t('1M 上下文'), sub: t('长对话超过 20 万 token 后按长上下文价格计；关着时到 20 万就自动压缩') },
  ];

  function fill(r) {
    p = r.policy; regOpen = !!r.registrationOpen;
    const q = p.quota || {};
    form = {
      ...Object.fromEntries(FIELDS.map((f) => [f.k, q[f.k] ?? ''])),
      maxUserTurns: p.maxUserTurns || '', maxParallelPerUser: p.maxParallelPerUser || '', maxRoutinesPerUser: p.maxRoutinesPerUser || '',
      timezone: p.timezone || '',
    };
  }
  async function load() { try { fill(await api.get('/api/admin/policy')); } catch (e) { saToast(t('读取失败：{reason}', { reason: tr(String(e?.message || e)) }), true); } }
  $effect(() => { sa.tick; load(); });

  async function save(patch, okMsg = t('已保存')) {
    if (busy) return; busy = true;
    try {
      const r = await api.post('/api/admin/policy', patch);
      if (r?.error) throw new Error(r.error);
      fill({ policy: r.policy, registrationOpen: r.registrationOpen });
      saToast(okMsg);
    } catch (e) { saToast(tr(e?.body?.error || e?.message) || t('保存失败'), true); }
    busy = false;
  }
  const toggleRegister = () => save({ register: !p.register }, p.register ? t('已关闭注册') : t('已开放邀请码注册'));
  const num = (v) => (v === '' || v == null ? 0 : v);
  function saveQuota() {
    save({
      quota: Object.fromEntries(FIELDS.map((f) => [f.k, form[f.k]])),
      maxUserTurns: num(form.maxUserTurns),
      maxParallelPerUser: num(form.maxParallelPerUser),
      maxRoutinesPerUser: num(form.maxRoutinesPerUser),
      timezone: String(form.timezone || '').trim() || 'Asia/Shanghai',
    });
  }
  const toggleMember = (k) => save({ member: { [k]: !p.member?.[k] } }, p.member?.[k] ? t('已对成员关闭') : t('已对成员开放'));
  async function useRecommended() {
    // 给程序用的号（QQ 机器人这类）没标服务账号的话，它和它铸的聊天快照也会按成员限额：手上有快照的点名，没有也提一句
    await loadUsers();   // 用户列表可能还没拉过（没进过「用户」页）
    const bots = (sa.users || []).filter((u) => u.snapMinter && !u.service).map((u) => u.name);
    const warn = bots.length
      ? t('{names} 手上有聊天快照，但还不是服务账号：改了之后它和它铸的快照也会按成员限额。给程序用的号请先到「用户」里标成服务账号。', { names: bots.join(', ') })
      : t('给程序用的号（例如 QQ 机器人）请先到「用户」里标成服务账号，否则它和它铸的聊天快照也会按成员限额。');
    if (!(await saConfirm(t('改用推荐的额度？'), t('默认额度、全服与每人并发、每人定时任务数和成员的高消耗功能都换成推荐值（给别人用的服务器的稳妥起点）。单独给某个人设过的额度不受影响。') + ' ' + warn, { yes: t('改用推荐值') }))) return;
    save({ preset: 'recommended' }, t('已改用推荐值'));
  }
</script>

{#if p}
  <div class="sa-card">
    <div class="sa-card-h">{tc('admin', '注册')}</div>
    <div class="sa-rows">
      <div class="sa-row">
        <span class="sa-row-tx">
          <span>{t('凭邀请码注册')}</span>
          <small>{!sa.multiUser ? t('这台主机没开多用户，注册始终关闭；要给别人用，在「用户」页最上面打开「给别人用」') : p.register ? t('拿到邀请码的人可以自己注册账号') : t('已关闭：只剩你在「用户」页直接建账号')}</small>
        </span>
        <button class="sa-sw" class:on={p.register && sa.multiUser} disabled={!sa.multiUser || busy} onclick={toggleRegister} aria-label={t('凭邀请码注册')}><span class="sa-sw-knob"></span></button>
      </div>
    </div>
  </div>
  <div class="sa-foot">{t('关掉之后，已经发出去还没用的邀请码也用不了；已有账号照常登录。')}</div>

  <div class="sa-card" style="margin-top:14px">
    <div class="sa-card-h">{t('注册用户的默认额度')}</div>
    <div class="grid">
      {#each FIELDS as f (f.k)}
        <label class="fld">
          <span class="fl">{f.label}</span>
          <span class="fi"><input class="sa-in" type="number" min="0" step={f.step} placeholder={t('不限')} bind:value={form[f.k]} /><em>{f.unit}</em></span>
        </label>
      {/each}
      <label class="fld">
        <span class="fl">{t('全服同时最多几轮（注册用户合计）')}</span>
        <span class="fi"><input class="sa-in" type="number" min="0" step="1" placeholder={t('不限')} bind:value={form.maxUserTurns} /><em>{tc('admin', '轮')}</em></span>
      </label>
      <label class="fld">
        <span class="fl">{t('每人同时最多几轮')}</span>
        <span class="fi"><input class="sa-in" type="number" min="0" step="1" placeholder={t('不限')} bind:value={form.maxParallelPerUser} /><em>{tc('admin', '轮')}</em></span>
      </label>
      <label class="fld">
        <span class="fl">{t('每人最多几条启用中的定时任务')}</span>
        <span class="fi"><input class="sa-in" type="number" min="0" step="1" placeholder={t('不限')} bind:value={form.maxRoutinesPerUser} /><em>{t('条')}</em></span>
      </label>
      <label class="fld">
        <span class="fl">{t('「每天」按哪个时区换日')}</span>
        <span class="fi"><input class="sa-in" type="text" placeholder="Asia/Shanghai" bind:value={form.timezone} spellcheck="false" /></span>
      </label>
    </div>
    <div class="acts">
      <button class="sa-btn" onclick={useRecommended} disabled={busy}>{t('改用推荐值')}</button>
      <button class="sa-btn pri" onclick={saveQuota} disabled={busy}>{t('保存')}</button>
    </div>
  </div>
  <div class="sa-foot">
    {t('留空或填 0 = 不限。额度只算 Claude（Claude 对话和定时任务都算轮数），dimensio 不计；管理员不受限，服务账号不吃默认额度（要限就单独设）。')}
    {t('轮数在开跑时记（同时发几轮也绕不过去），花费按每轮结束时 Claude 报的金额、取这一轮新增的那部分记。某个人要多给或少给，到「用户」页他的「管理」里单独设。')}
    {costNote()}
  </div>

  <div class="sa-card" style="margin-top:14px">
    <div class="sa-card-h">{t('成员能用的高消耗功能')}</div>
    <div class="sa-rows">
      {#each MEMBER_FEATS as f (f.k)}
        <div class="sa-row">
          <span class="sa-row-tx"><span>{f.label}</span><small>{f.sub}</small></span>
          <button class="sa-sw" class:on={!!p.member?.[f.k]} disabled={busy} onclick={() => toggleMember(f.k)} aria-label={f.label}><span class="sa-sw-knob"></span></button>
        </div>
      {/each}
    </div>
  </div>
  <div class="sa-foot">{t('只管注册用户（服务账号除外）；管理员自己与管理员代发的轮不受限。关掉的功能，成员那边按钮照常在，但发出去会按关着的处理。')}</div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px 16px; padding: 14px 18px 4px; }
  .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .fl { font-size: 12.5px; color: var(--sa-tx2); }
  .fi { display: flex; align-items: center; gap: 8px; }
  .fi em { font-style: normal; font-size: 12.5px; color: var(--sa-tx3); flex: none; }
  .fi .sa-in { height: 40px; }
  .acts { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 18px 16px; }
  .sa-sw:disabled { opacity: .4; cursor: default; }
</style>
