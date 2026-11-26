<script>
  // 输入栏的「＋」：先选这份素材的用处（只有一种可用就跳过这一步），再选来源（作品 / 工作空间 / 这台设备）。
  // 角色是否可用按当前模型的 inputs 判断（roleOk），不可用的写明原因；可用的只写名字，不配解释小字。
  // 「作品」：宽一些的屏交给左边的素材架进挑选态（onworks）；手机上就在这张表单里翻到作品格子，点一张就挂上（onworkpick）。
  import { t } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { studio, roleName, roleOk, mediaSrc, ensureWall } from '../../modules/studio/media.svelte.js';
  import { roleAccepts, payloadKind, assetPayload } from '../../modules/studio/drag.js';
  import { icon, ROLE_ICON } from '../../modules/studio/icons.js';
  import Layer from './ui/Layer.svelte';
  import Img from './ui/Img.svelte';

  let { page, model, roles = [], anchor = null, onworks, onworkpick, onworkspace, ondevice, onclose } = $props();

  const okRoles = $derived(roles.filter((r) => roleOk(page, r, model).ok));
  let role = $state(initialRole());
  let step = $state('');            // '' = 选来源 · works = 手机上的作品格子
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

  // 作品格子：能当这个角色的作品（图像角色看图像墙，视频看视频墙，音频看配音 + 音乐墙），再补上素材架里已有的
  const WALLS = { image: ['image'], video: ['video'], audio: ['voice', 'music'] };
  const want = $derived(roleAccepts(role));
  $effect(() => { if (step === 'works') for (const p of WALLS[want] || []) ensureWall(p); });
  const works = $derived.by(() => {
    if (step !== 'works') return [];
    const seen = new Set(), out = [];
    const all = [...(WALLS[want] || []).flatMap((p) => studio.walls?.[p]?.items || []), ...(studio.assets || [])];
    for (const a of all) {
      if (!a?.id || seen.has(a.id) || payloadKind(assetPayload(a)) !== want) continue;
      seen.add(a.id); out.push(a);
      if (out.length >= 90) break;
    }
    return out;
  });
  const loadingWorks = $derived(step === 'works' && (WALLS[want] || []).some((p) => studio.walls?.[p]?.loading));
  function fromWorks() {
    if (layout.compact) step = 'works';
    else onworks?.(role);
  }
  const title = $derived(step === 'works' ? t('选一张当{role}', { role: roleName(role) })
    : role ? (audio ? t('添加音频') : role === 'video' ? t('添加视频') : t('添加图片')) : t('添加素材'));
</script>

<Layer {title} {anchor} align="start" prefer="up" width={step === 'works' ? 440 : 280} tall={step === 'works'} {onclose}>
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
  {:else if step === 'works'}
    {#if works.length}
      <div class="aa-works">
        {#each works as a (a.id)}
          <button class="aa-w" aria-label={a.prompt ? a.prompt.slice(0, 60) : t('作品')} onclick={(e) => onworkpick?.(role, a, e.currentTarget)}>
            {#if a.kind === 'image' || a.kind === 'video'}<Img src={mediaSrc(a, 'thumb')} alt="" />
            {:else}<span class="aa-au">{@html icon(a.kind === 'music' ? 'music' : 'voice')}<small>{a.prompt || ''}</small></span>{/if}
            {#if a.kind === 'video'}<span class="aa-pl" aria-hidden="true">{@html icon('play')}</span>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <p class="op-none">{loadingWorks ? t('正在加载作品') : t('还没有能用的作品')}</p>
    {/if}
    <button class="op-back" onclick={() => (step = '')}>{@html icon('back')}{t('换个来源')}</button>
  {:else}
    <div>
      <button class="op" onclick={fromWorks}>
        <span class="op-ic">{@html icon('image')}</span>
        <span class="op-tx"><b>{t('作品')}</b></span>
      </button>
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
