<script>
  // 额度与注册（三端拆分 P4）：注册开不开、注册用户的默认额度、全服同时最多几轮、「每天」按哪个时区换日。
  // 数据面 /api/admin/policy（存 config.json 的 policy 键，即时生效）。个人额度在「用户」页按人覆盖。
  // 额度只算 Claude：共享的是 Claude 订阅；dimensio 不计。管理员不受限。
  import { api } from '../../lib/api.js';
  import { sa, saToast } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  let p = $state(null);               // { register, quota:{...}, maxUserTurns, timezone }
  let regOpen = $state(false);
  let form = $state({ dayTurns: '', weekTurns: '', dayCostUsd: '', weekCostUsd: '', maxUserTurns: '', timezone: '' });
  let busy = $state(false);

  function fill(r) {
    p = r.policy; regOpen = !!r.registrationOpen;
    const q = p.quota || {};
    form = {
      dayTurns: q.dayTurns ?? '', weekTurns: q.weekTurns ?? '', dayCostUsd: q.dayCostUsd ?? '', weekCostUsd: q.weekCostUsd ?? '',
      maxUserTurns: p.maxUserTurns || '', timezone: p.timezone || '',
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
  function saveQuota() {
    save({
      quota: { dayTurns: form.dayTurns, weekTurns: form.weekTurns, dayCostUsd: form.dayCostUsd, weekCostUsd: form.weekCostUsd },
      maxUserTurns: form.maxUserTurns === '' ? 0 : form.maxUserTurns,
      timezone: String(form.timezone || '').trim() || 'Asia/Shanghai',
    });
  }
  const FIELDS = [
    { k: 'dayTurns', label: t('每天最多几轮'), unit: tc('admin', '轮'), step: 1 },
    { k: 'weekTurns', label: t('最近 7 天最多几轮'), unit: tc('admin', '轮'), step: 1 },
    { k: 'dayCostUsd', label: t('每天最多花多少'), unit: t('美元'), step: 0.5 },
    { k: 'weekCostUsd', label: t('最近 7 天最多花多少'), unit: t('美元'), step: 1 },
  ];
</script>

{#if p}
  <div class="sa-card">
    <div class="sa-card-h">{tc('admin', '注册')}</div>
    <div class="sa-rows">
      <div class="sa-row">
        <span class="sa-row-tx">
          <span>{t('凭邀请码注册')}</span>
          <small>{!sa.multiUser ? t('这台主机没开多用户，注册始终关闭') : p.register ? t('拿到邀请码的人可以自己注册账号') : t('已关闭：只剩你在「用户」页直接建账号')}</small>
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
        <span class="fl">{t('「每天」按哪个时区换日')}</span>
        <span class="fi"><input class="sa-in" type="text" placeholder="Asia/Shanghai" bind:value={form.timezone} spellcheck="false" /></span>
      </label>
    </div>
    <div class="acts"><button class="sa-btn pri" onclick={saveQuota} disabled={busy}>{t('保存')}</button></div>
  </div>
  <div class="sa-foot">
    {t('留空或填 0 = 不限。额度只算 Claude（大家共用的是服务器上的 Claude 订阅），dimensio 不计；管理员不受限。')}
    {t('轮数在开跑时记（同时发几轮也绕不过去），花费按每轮结束时 Claude 报的金额记。某个人要多给或少给，到「用户」页他的「管理」里单独设。')}
  </div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px 16px; padding: 14px 18px 4px; }
  .fld { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .fl { font-size: 12.5px; color: var(--sa-tx2); }
  .fi { display: flex; align-items: center; gap: 8px; }
  .fi em { font-style: normal; font-size: 12.5px; color: var(--sa-tx3); flex: none; }
  .fi .sa-in { height: 40px; }
  .acts { display: flex; justify-content: flex-end; padding: 10px 18px 16px; }
  .sa-sw:disabled { opacity: .4; cursor: default; }
</style>
