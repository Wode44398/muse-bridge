<script>
  // 模型与强度（锚在输入栏的模型按钮上）：上半截强度滑杆 + Fast，下半截按来源分组的模型列表。
  //   号池那组排最前（多个号时标出这个模型在哪些号上有），模型中心按服务一组（标志 + 名字，成员看到的标「管理员共享」）；
  //   每组默认模型排第一，一组超过 8 个只露前 6 个，余下收成一行点开；条目多时出现搜索（型号、服务名都能搜）；
  //   右边是上下文大小（猜的带 ≈）；↑↓ 挪、Enter 选。选了模型弹层不关：滑杆的档点当场挪到新模型的档位上，接着就能拨强度。
  import { tick } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { codex, modelGroups, selectModel, isAdmin } from '../../lib/codex/store.svelte.js';
  import { cxPop, closePop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import { accLabel } from '../../lib/codex/settings-logic.js';
  import { openSettingsFromChat, canOpenSettingsFromChat } from '../../lib/settingsNav.svelte.js';
  import { fmtCtx, needSearch, pickerGroups, accountsText, brandOfModel, groupBrand } from '../../lib/codex/picker/format.js';
  import BrandLogo from '../modelhub/BrandLogo.svelte';
  import Popover from './Popover.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import Icon from './Icon.svelte';

  // 这一组里有没有和服务标不一样的牌子（转发站）
  const mixed = (g) => g.key !== 'pool' && (g.items || []).some((m) => { const b = brandOfModel(m.name, m.id); return b && b !== groupBrand(g); });
  const open = $derived(cxPop.id === 'picker');
  const groups = $derived(modelGroups());
  const searchable = $derived(needSearch(groups));
  const poolAccounts = $derived(Array.isArray(codex.pool?.accounts) ? codex.pool.accounts : []);

  let q = $state('');
  let expanded = $state([]);
  let justOpened = $state('');   // 刚点开的那组：新露出来的行逐个长出来
  let kb = $state(-1);
  let listEl = $state(null);
  let searchEl = $state(null);
  let hTop = $state(0), hSearch = $state(0), hFoot = $state(0);

  const view = $derived(pickerGroups(groups, { q, expanded, selected: codex.model }));
  const flat = $derived(view.flatMap((g) => g.shown));

  // 每次打开：清搜索、清键盘高亮，选中的那行滚进视野；桌面上光标直接进搜索框
  $effect(() => {
    if (!open) return;
    q = '';
    kb = -1;
    justOpened = '';
    tick().then(() => {
      const on = listEl?.querySelector('.pk-row[aria-checked="true"]');
      if (on) reveal(on, true);
      let fine = false;
      try { fine = matchMedia('(pointer: fine)').matches; } catch {}
      if (fine && searchEl) searchEl.focus({ preventScroll: true });
    });
  });

  // 列表高度：弹层能用的高度减去上下几块，最多 300、最少 120
  const listMax = (avail) => Math.max(120, Math.min(300, (avail || 9999) - hTop - hSearch - hFoot - 14));

  function reveal(el, instant = false) {
    if (!listEl || !el) return;
    const top = el.offsetTop - listEl.offsetTop, bot = top + el.offsetHeight;
    const to = top < listEl.scrollTop ? top - 6 : bot > listEl.scrollTop + listEl.clientHeight ? bot - listEl.clientHeight + 6 : null;
    if (to == null) return;
    listEl.scrollTo({ top: to, behavior: instant || reduced() ? 'instant' : 'smooth' });
  }

  function pick(m) {
    if (m.id === codex.model) return;
    selectModel({ model: m.id });
    haptic('tick');
  }

  function expand(key) {
    if (expanded.includes(key)) return;
    justOpened = key;
    expanded = [...expanded, key];
  }

  function onKey(e) {
    if (!flat.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      kb = kb < 0 ? (d > 0 ? 0 : flat.length - 1) : (kb + d + flat.length) % flat.length;
      tick().then(() => reveal(listEl?.querySelector('.pk-row.kb')));
    } else if (e.key === 'Enter' && (kb >= 0 || e.target === searchEl)) {
      e.preventDefault();
      const m = flat[kb >= 0 ? kb : 0];
      if (m) pick(m);
    }
  }

  function onSearch(e) {
    q = e.currentTarget.value;
    kb = q.trim() ? 0 : -1;
  }

  function manageHub() {
    closePop('picker');
    openSettingsFromChat('model-hub');
  }

  // 新露出来的行：从零高度长出来，一行接一行
  // （行有 min-height，所以连 min-height 一起从 0 长）
  function rowIn(node, { on, i }) {
    if (!on || reduced()) return {};
    const h = node.offsetHeight + 'px';
    anim(node, [
      { height: '0px', minHeight: '0px', opacity: 0, overflow: 'hidden' },
      { height: h, minHeight: h, opacity: 1, overflow: 'hidden' },
    ], { dur: 260, delay: Math.min(i, 8) * 22, ease: EASE.soft });
    return {};
  }

  const tagOf = (g) => (g.shared ? t('管理员共享') : g.hub ? t('模型中心') : poolAccounts.length > 1 ? t('号池 {n} 个号', { n: poolAccounts.length }) : '');
  const groupName = (g) => (g.key === 'pool' ? t('ChatGPT 账号') : g.name);
</script>

<Popover id="picker" side="top" align="end" gap={10} class="picker" role="dialog" label={t('模型与强度')}>
  {#snippet children({ avail })}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pk-body" onkeydown={onKey}>
      <div class="pk-slider" bind:offsetHeight={hTop}>
        <EffortSlider />
      </div>
      <div class="pop-sep"></div>
      {#if searchable}
        <div class="pk-search" bind:offsetHeight={hSearch}>
          <Icon name="search" />
          <input
            bind:this={searchEl}
            value={q}
            oninput={onSearch}
            placeholder={t('搜索型号或服务')}
            aria-label={t('搜索型号或服务')}
            spellcheck="false"
            autocomplete="off"
          />
        </div>
      {/if}
      <div class="pk-list" bind:this={listEl} role="group" style="max-height:{listMax(avail)}px">
        {#each view as g (g.key)}
          <div class="pk-grp">
            <!-- 服务标：模型中心给的是品牌标的键（BrandLogo 认的那套）；没带就按组里的型号名认，认不出画首字头像 -->
            <span class="svc" class:img={g.key === 'pool' || !!groupBrand(g)}>
              {#if g.key === 'pool'}
                <Icon name="codex" size={12} />
              {:else}
                <BrandLogo logo={groupBrand(g)} name={g.name} size={14} plain />
              {/if}
            </span>
            <span class="gname">{groupName(g)}</span>
            <span class="tag">{tagOf(g)}</span>
          </div>
          {#each g.shown as m, i (m.id)}
            {@const where = g.key === 'pool' ? accountsText(m.accounts, poolAccounts, accLabel) : ''}
            <button
              type="button"
              class="pk-row"
              class:kb={flat[kb]?.id === m.id}
              role="menuitemradio"
              aria-checked={m.id === codex.model}
              onclick={() => pick(m)}
              onpointermove={() => { if (kb >= 0 && flat[kb]?.id !== m.id) kb = -1; }}
              use:rowIn={{ on: justOpened === g.key && i >= 6, i: i - 6 }}
            >
              <!-- 转发站（OpenRouter 这类）一组里各家都有：这一组每行名字前都留一枚标的位置（认不出的空着），名字才对得齐 -->
              {#if mixed(g)}
                <span class="mbrand">{#if brandOfModel(m.name, m.id)}<BrandLogo logo={brandOfModel(m.name, m.id)} name={m.name} size={13} plain />{/if}</span>
              {/if}
              <span class="nm">{m.name}{#if where}<em>{where}</em>{/if}</span>
              <span class="ctx">{fmtCtx(m.ctx, m.ctxGuess)}</span>
              <Icon name="check" class="ck" />
            </button>
          {/each}
          {#if g.more > 0}
            <button type="button" class="pk-more" onclick={() => expand(g.key)}>
              {t('还有 {n} 个', { n: g.more })}<Icon name="chev" class="cv" size={14} />
            </button>
          {/if}
        {:else}
          <div class="pk-empty">{groups.length ? t('没有匹配的模型') : t('还没拿到模型目录')}</div>
        {/each}
      </div>
      {#if isAdmin() && canOpenSettingsFromChat}
        <div class="pk-foot" bind:offsetHeight={hFoot}>
          <button type="button" class="mi" onclick={manageHub}>
            <Icon name="model" class="mi-ico" />
            <span class="lb">{t('管理模型中心…')}</span>
          </button>
        </div>
      {/if}
    </div>
  {/snippet}
</Popover>

<style>
  .pk-body { display: flex; flex-direction: column; min-height: 0; }
  .pk-grp .svc { flex: none; overflow: hidden; }
  .pk-grp .svc > :global(svg) { width: 12px; height: 12px; }
  /* 有品牌标时不要底托：标自己就是彩色 / 黑白的整枚，套在灰底里反而像个按钮 */
  .pk-grp .svc.img { background: none; color: var(--fg); }   /* 单色标（OpenAI、Grok）跟着字色走：分组头那层浅灰会把它淡没 */
  .pk-grp .gname { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pk-grp .tag { white-space: nowrap; }
  .pk-row :global(.ck) { flex: none; transition: opacity calc(var(--k, 1) * 150ms) ease; }
  .pk-more :global(.cv) { width: 14px; height: 14px; }
  .pk-list { overscroll-behavior: contain; }
  .mbrand { flex: none; display: inline-flex; width: 13px; margin-right: 8px; }
</style>
