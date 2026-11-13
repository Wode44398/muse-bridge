<script>
  // 落点托盘（§5.1 表 + §5.2 视觉）：拖着作品卡 / 工作空间文件进创作页时，输入框上方升起一排角色槽（按当前模型的 inputs 生成）。
  // 三态：可放（虚线框）、悬停（实线墨框 + 下沉底 + 轻放大）、不可放（淡出；原因放 title，不在格子里写小字——130% 字号下会拆成四行）。
  //
  // 触屏 / 指针拖拽：每个槽是一个 dropZone（全域拖放命中最内层落点）；
  // 桌面 HTML5（工作空间电脑版拖文件、从系统拖图片进来）：dragover 阶段读不到内容，只按模型能力判断，松手时再按真实内容落。
  import { t } from '../../lib/i18n.js';
  import { drag, dropZone, dragPayload } from '../../lib/dragdrop.svelte.js';
  import { roleName, roleOk } from '../../modules/studio/media.svelte.js';
  import { SLOTS, OPTIONAL_SLOTS, slotState, slotDropFor } from '../../modules/studio/drag.js';
  import { icon, ROLE_ICON } from '../../modules/studio/icons.js';

  let { page, model, html5 = null, onhtml5drop = null } = $props();

  // 指针拖拽此刻拎着的东西（只在拖拽中有意义；dragPayload 不是响应式的，靠 drag.on / overKey 触发重算）
  const payload = $derived(drag.on ? (drag.overKey, dragPayload()) : null);
  const live = $derived(!!payload || !!html5);
  const LABEL_TEXT = { image: t('作为提示词'), video: t('作为提示词'), voice: t('朗读文本'), music: t('作为提示词') };
  const nameOf = (role) => (role === 'text' ? LABEL_TEXT[page] : roleName(role));
  const REASON = {
    kind: () => t('放不了这类素材'),
    model: () => t('当前模型不接收'),
    full: (s) => t('最多 {n} 张', { n: s.max }),
    refMix: () => t('已有参考图'),
    frameMix: () => t('已有首尾帧'),
  };
  function stateOf(role) {
    if (payload) return slotState(page, role, payload);
    if (html5) return role === 'text' ? { ok: true } : roleOk(page, role, model);
    return { ok: false };
  }
  // 视频页的参考视频 / 参考音频槽只在当前模型收它们时才摆（Seedance 这类）；别的模型不占位置
  const slots = $derived(SLOTS[page].filter((r) => !(OPTIONAL_SLOTS[page] || []).includes(r) || !!model?.inputs?.[r]).map((role) => ({ role, st: (model, stateOf(role)) })));
  const allOff = $derived(live && slots.every((s) => !s.st.ok));
  const offText = $derived(slots.every((s) => s.st.reason === 'kind') ? t('这一页用不上这类素材') : t('当前模型不接收这类素材'));

  function slot(node, role) {
    const opts = (r) => ({
      key: 'studio-slot:' + page + ':' + r, effect: 'send',
      label: () => t('松开用作{role}', { role: nameOf(r) }),
      accept: (p) => !!slotDropFor(page, p, r),
      drop: (p) => slotDropFor(page, p, r)?.(),
    });
    const z = dropZone(node, opts(role));
    return { update: (n) => z.update(opts(n)), destroy: z.destroy };
  }
  let over5 = $state('');
</script>

{#if live}
  <div class="dt" class:off={allOff} role="group" aria-label={t('把素材放到哪里')}>
    {#if allOff}
      <div class="dt-off">{offText}</div>
    {:else}
      {#each slots as s (s.role)}
        <div class="dt-slot" class:ok={s.st.ok} title={s.st.ok ? null : (REASON[s.st.reason] || REASON.model)(s.st)} class:over={(drag.on && drag.overKey === 'studio-slot:' + page + ':' + s.role) || over5 === s.role}
          use:slot={s.role}
          ondragover={(e) => { if (!html5 || !s.st.ok) return; e.preventDefault(); e.stopPropagation(); over5 = s.role; }}
          ondragleave={() => { if (over5 === s.role) over5 = ''; }}
          ondrop={(e) => { if (!html5 || !s.st.ok) return; e.preventDefault(); e.stopPropagation(); over5 = ''; onhtml5drop?.(e, s.role); }}>
          <span class="dt-ic">{@html icon(ROLE_ICON[s.role] || 'image')}</span>
          <b>{nameOf(s.role)}</b>
        </div>
      {/each}
    {/if}
  </div>
{/if}
