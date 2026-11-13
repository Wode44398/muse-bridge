<script>
  // 输入框的「＋」：先选这份素材的用处（只有一种可用就跳过这一步），再选来源（工作空间 / 这台设备）。
  // 角色是否可用按当前模型的 inputs 判断（roleOk），不可用的写明原因；可用的只写名字，不配解释小字。
  import { t } from '../../lib/i18n.js';
  import { roleName, roleOk } from '../../modules/studio/media.svelte.js';
  import { icon, ROLE_ICON } from '../../modules/studio/icons.js';
  import Layer from './ui/Layer.svelte';

  let { page, model, roles = [], anchor = null, onworkspace, ondevice, onclose } = $props();

  const okRoles = $derived(roles.filter((r) => roleOk(page, r, model).ok));
  let role = $state(initialRole());
  function initialRole() {
    const ok = roles.filter((r) => roleOk(page, r, model).ok);
    return roles.length === 1 || ok.length === 1 ? ok[0] || roles[0] : '';
  }
  const audio = $derived(role === 'audio');
  function reason(st) {
    if (st.reason === 'full') return t('最多 {n} 张', { n: st.max });
    if (st.reason === 'refMix') return t('已有参考图时不能用首尾帧');
    if (st.reason === 'frameMix') return t('已有首尾帧时不能用参考图');
    return t('当前模型不接收');
  }
</script>

<Layer title={role ? (audio ? t('添加音频') : role === 'video' ? t('添加视频') : t('添加图片')) : t('添加素材')} {anchor} align="start" prefer="up" width={280} {onclose}>
  {#if !role}
    <div>
      {#each roles as r (r)}
        {@const st = roleOk(page, r, model)}
        <button class="op" disabled={!st.ok} onclick={() => (role = r)}>
          <span class="op-ic">{@html icon(ROLE_ICON[r] || 'image')}</span>
          <span class="op-tx"><b class="cap1">{st.replace ? t('替换{role}', { role: roleName(r) }) : roleName(r)}</b>{#if !st.ok}<small>{reason(st)}</small>{/if}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div>
      <button class="op" onclick={() => onworkspace?.(role)}>
        <span class="op-ic">{@html icon('folder')}</span>
        <span class="op-tx"><b>{t('工作空间')}</b></span>
      </button>
      <button class="op" onclick={() => ondevice?.(role)}>
        <span class="op-ic">{@html icon('device')}</span>
        <span class="op-tx"><b>{t('这台设备')}</b></span>
      </button>
    </div>
    {#if okRoles.length > 1}<button class="op-back" onclick={() => (role = '')}>{@html icon('back')}{roleName(role)}</button>{/if}
  {/if}
</Layer>
