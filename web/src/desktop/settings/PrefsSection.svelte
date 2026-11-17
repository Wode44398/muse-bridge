<script>
  // 桌面设置里的几个小分区：通用、外观、额度与注册、快捷键、壁纸（按当前分区画其中一个）。
  // 状态在外壳创建的控制器里（./ctx.js 的 useDesk），这里只画；样式是同一套 kit.css。
  import { useDesk } from './ctx.js';
  import { bgStyle } from '../../lib/settings/common.js';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DSlider from '../kit/DSlider.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import NotifySection from './NotifySection.svelte';
  import ShortcutRecorder from './ShortcutRecorder.svelte';
  import { DARK_IDS, LIGHT_IDS, deleteUpload, setSpatialAmp, setSpatialOn, spatial, wp, wpHasDepth, wpIsUpload } from '../../lib/wallpaper.svelte.js';
  import { FLUX_COLORMODES, FLUX_SLIDERS, fluxParams, prefs, resetFlux, saveFlux, ui } from '../../lib/state.svelte.js';
  import { LANGS, lang, setLang, t, tc, tr } from '../../lib/i18n.js';
  import { ags, savePolicy } from '../../lib/agentSettings.svelte.js';
  import { SI } from '../../lib/settingsIcons.js';

  const D = useDesk();
  const { ag, gen, sc, wpd } = D;
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;
</script>
{#if D.sec === 'general'}

  <DGroup label={t('语言')}>
    <DRow title={t('界面语言')} highlight={D.fl('lang')}>
      {#snippet trailing()}<DSegmented options={LANGS} value={lang()} onchange={setLang} />{/snippet}
    </DRow>
  </DGroup>
  <NotifySection highlight={D.fl} onMaster={(v) => { try { D.agCtl?.setNotify?.(v); } catch {} }} />
  <DGroup label={t('系统')}>
    {#if D.asCtl && gen.autoStart.supported}
      <DRow title={t('开机自动启动')} highlight={D.fl('autostart')}>
        {#snippet trailing()}<DSwitch checked={gen.autoStart.enabled} onchange={gen.onAutoStart} />{/snippet}
      </DRow>
    {/if}
    <DRow title={t('原图加载')} highlight={D.fl('fullres')}>
      {#snippet trailing()}<DSwitch checked={prefs.fullResMedia} onchange={gen.onFullRes} />{/snippet}
    </DRow>
  </DGroup>

{:else if D.sec === 'appearance'}

  <div class="themes" class:hl-line={D.fl('theme')} role="radiogroup" aria-label={t('外观')}>
    {#each [['light', t('明亮')], ['dark', t('深色')], ['auto', t('跟随系统')]] as [v, name] (v)}
      <button class="tp" class:on={gen.themeNow === v} role="radio" aria-checked={gen.themeNow === v} onclick={() => gen.pickTheme(v)}>
        <span class="tp-art {v}" aria-hidden="true">
          {#each v === 'auto' ? ['light', 'dark'] : [v] as half (half)}
            <span class="half {half}"><i></i><i></i><i></i></span>
          {/each}
        </span>
        <span class="tp-name">{name}</span>
      </button>
    {/each}
  </div>
  <DGroup>
    <DRow title={t('禁用转场动画')} highlight={D.fl('noanim')}>
      {#snippet trailing()}<DSwitch checked={prefs.noEnterAnim} onchange={gen.onNoAnim} />{/snippet}
    </DRow>
  </DGroup>

{:else if D.sec === 'policy'}

  {#if ags.policy}
    <DGroup>
      <DRow title={t('凭邀请码注册')} highlight={D.fl('policy')}>
        {#snippet trailing()}<DSwitch checked={ags.policy.register} onchange={(v) => savePolicy({ register: v })} />{/snippet}
      </DRow>
    </DGroup>
    <DGroup label={t('注册用户的默认额度')} foot={t('只算 Claude，管理员不受限。留空或填 0 = 不限。')}>
      {#each ag.POLICY_FIELDS as f (f.k)}
        <DRow title={f.label()}>
          {#snippet trailing()}
            <span class="numf"><DField value={ag.policyVal(f.k) ? String(ag.policyVal(f.k)) : ''} placeholder={t('不限')} width="92px" onchange={(v) => ag.savePolicyField(f.k, v)} /><i>{f.unit()}</i></span>
          {/snippet}
        </DRow>
      {/each}
      <DRow title={t('「每天」按哪个时区换日')}>
        {#snippet trailing()}<DField value={ags.policy.timezone || 'Asia/Shanghai'} width="170px" onchange={(v) => ag.savePolicyField('timezone', v)} />{/snippet}
      </DRow>
    </DGroup>
    {#if ags.err}<p class="err">{ags.err}</p>{/if}
  {/if}

{:else if D.sec === 'shortcuts'}

  {#each sc.scState.groups as g}
    <DGroup
      label={tr(g.label)}
      foot={g.id === 'safety'
        ? t('急停键的组合刻意难按出来：一个拿到桌面权限的 agent 不该能自己复现另一把钥匙。改之前想清楚。')
        : g.id === 'ask' ? t('点键位改键，按 Backspace 关掉这一条。') : ''}
    >
      {#each sc.scItemsOf(g.id) as item}
        <DRow title={tr(item.label)} sub={item.failure || item.duplicate || item.invalid || !item.enabled ? sc.scSub(item) : ''}
          danger={Boolean(item.failure || item.duplicate)} highlight={D.fl('sc-' + item.id)}>
          {#snippet trailing()}
            <ShortcutRecorder accelerator={item.accelerator} placeholder={t('已关闭')} onrecord={(accel) => sc.scSet(item.id, accel)} />
          {/snippet}
        </DRow>
      {/each}
    </DGroup>
  {/each}
  <DGroup>
    {#if sc.scError}<DRow title={t('改键没成功')} sub={sc.scError} danger />{/if}
    <DRow title={t('全部恢复默认')}>
      {#snippet trailing()}<DButton size="sm" onclick={sc.scReset}>{t('恢复默认')}</DButton>{/snippet}
    </DRow>
  </DGroup>

{:else if D.sec === 'wallpaper'}

  {#if wpd.wpErr}<p class="err sel-text">{wpd.wpErr}</p>{/if}
  {#each [['light', t('明亮系统'), LIGHT_IDS, 'wp-light'], ['dark', t('深色系统'), DARK_IDS, 'wp-dark']] as [slot, name, ids, fid] (slot)}
    <DGroup label={name} foot={t('上传时同时选中原图和它的深度图（文件名带 depth），就能开空间壁纸。')}>
      <div class="wpgrid" class:hl-line={D.fl(fid)}>
        {#each wpd.gridOf(ids) as id (id)}
          <div class="wpc" class:sel={wp[slot] === id}>
            <button class="wpbg" style={bgStyle(id)} onclick={() => wpd.pick(slot, id)} aria-label={t('选择壁纸')}></button>
            {#if wpIsUpload(id)}<button class="wpx" onclick={() => deleteUpload(id)} title={t('删除')}>{@html svgOf('plus', 2)}</button>{/if}
          </div>
        {/each}
        <button class="wadd" onclick={() => (slot === 'light' ? wpd.upInputL : wpd.upInputD).click()} title={t('相册上传')}>{@html svgOf('plus', 1.6)}</button>
      </div>
      <!-- 只有带深度图的壁纸（内置默认 / 上传时附了深度图）才有空间壁纸 -->
      {#if wpHasDepth(wp[slot])}
        <DRow title={t('空间壁纸')} highlight={slot === 'light' && D.fl('spatial')}>
          {#snippet trailing()}<DSwitch checked={spatial[slot].on} onchange={(v) => setSpatialOn(slot, v)} />{/snippet}
        </DRow>
        {#if spatial[slot].on}
          <DRow title={t('景深幅度')}>
            {#snippet trailing()}
              <span class="sldw"><DSlider value={spatial[slot].amp * 100} min={0} max={100}
                oninput={(v) => setSpatialAmp(slot, v / 100)} /><i>{Math.round(spatial[slot].amp * 100)}%</i></span>
            {/snippet}
          </DRow>
        {/if}
      {/if}
    </DGroup>
  {/each}
  <input type="file" accept="image/*" multiple hidden bind:this={wpd.upInputL} onchange={(e) => wpd.onUpload('light', e)} />
  <input type="file" accept="image/*" multiple hidden bind:this={wpd.upInputD} onchange={(e) => wpd.onUpload('dark', e)} />
  {#if ui.glassMode === 'A'}
    <DGroup label={t('流体壁纸')}>
      <DRow title={tc('settings', '配色')} highlight={D.fl('flux')}>
        {#snippet trailing()}
          <DSelect options={FLUX_COLORMODES.map((c) => ({ value: c.id, label: c.name }))} value={fluxParams.colormode}
            onchange={(v) => { fluxParams.colormode = v; saveFlux(); }} width="130px" />
        {/snippet}
      </DRow>
      {#each FLUX_SLIDERS as s (s.key)}
        <DRow title={s.label}>
          {#snippet trailing()}
            <span class="sldw">{#if s.pow2}<DSlider value={Math.log2(fluxParams[s.key])} min={Math.log2(s.min)} max={Math.log2(s.max)} step={1}
              oninput={(v) => { fluxParams[s.key] = 2 ** Math.round(v); saveFlux(); }} />{:else}<DSlider value={fluxParams[s.key]} min={s.min} max={s.max} step={s.step || 1}
              oninput={(v) => { fluxParams[s.key] = v; saveFlux(); }} />{/if}<i>{s.step ? Number(fluxParams[s.key]).toFixed(s.step < 0.1 ? 2 : 1) : Math.round(fluxParams[s.key])}</i></span>
          {/snippet}
        </DRow>
      {/each}
      <DRow title={t('恢复默认参数')} chevron={false} onclick={resetFlux} />
    </DGroup>
  {/if}

{/if}

<style>
  @import './kit.css';
</style>
