<script>
  // 桌面基座验收画廊（dev-only，http://127.0.0.1:5173/?dkit）。i18n-ignore-file（开发专用页，不翻译）
  // 独立挂载（不跑 App），铺出全部基件的各状态 + 令牌可视化，明暗一键切换。
  import '../tokens.css';
  import DButton from './DButton.svelte';
  import DSwitch from './DSwitch.svelte';
  import DSegmented from './DSegmented.svelte';
  import DSlider from './DSlider.svelte';
  import DSelect from './DSelect.svelte';
  import DField from './DField.svelte';
  import DGroup from './DGroup.svelte';
  import DRow from './DRow.svelte';
  import { tooltip } from './tooltip.js';

  // 画廊自立桌面环境（真机由 preload 探测出 data-desktop；dev 浏览器手动立起）
  document.documentElement.dataset.desktop = '1';

  // ?dkit=light 预置亮色（headless 截图验收用；无值默认跟当前/暗色）
  let theme = $state(new URLSearchParams(location.search).get('dkit') === 'light'
    || document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  $effect(() => {
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
  });

  // demo 状态
  let sw1 = $state(true), sw2 = $state(false), sw3 = $state(true);
  let seg = $state('balanced');
  let sld1 = $state(42), sld2 = $state(78);
  let sel = $state('sonnet');
  let fld = $state('');
  let notif = $state(true);
  let quality = $state('high');

  const SEG_OPTS = [
    { value: 'still', label: '静帧' },
    { value: 'balanced', label: '均衡' },
    { value: 'full', label: '全效' },
  ];
  const MODEL_OPTS = [
    { value: 'fable', label: 'Fable 5' },
    { value: 'opus', label: 'Opus 5' },
    { value: 'sonnet', label: 'Sonnet 5' },
    { value: 'haiku', label: 'Haiku 4.5' },
    { value: 'k3', label: 'Kimi k3' },
    { value: 'g3', label: 'Gemini 3 Pro' },
    { value: 'ds', label: 'DeepSeek v4' },
  ];
  const QUALITY_OPTS = [
    { value: 'low', label: '省电' },
    { value: 'high', label: '高' },
    { value: 'ultra', label: '极致' },
  ];

  const SWATCHES = [
    ['bg', '--dsk-bg'], ['bg-raised', '--dsk-bg-raised'], ['panel', '--dsk-panel'],
    ['panel-strong', '--dsk-panel-strong'], ['hover', '--dsk-hover'], ['active', '--dsk-active'],
    ['line', '--dsk-line'], ['line-strong', '--dsk-line-strong'],
    ['accent', '--dsk-accent'], ['sel', '--dsk-sel'], ['ok', '--dsk-ok'], ['warn', '--dsk-warn'], ['crit', '--dsk-crit'],
  ];
  const RADII = [['xs', '--dsk-r-xs'], ['sm', '--dsk-r-sm'], ['md', '--dsk-r-md'], ['lg', '--dsk-r-lg'], ['xl', '--dsk-r-xl']];
  const SHADOWS = [['sh-1', '--dsk-sh-1'], ['sh-2', '--dsk-sh-2'], ['sh-3', '--dsk-sh-3']];
</script>

<div class="gal">
  <div class="wrap">
    <header class="hd">
      <div>
        <h1>桌面基座 · Kit 画廊</h1>
        <p>批1 验收：令牌系统 + 基件全状态。组件禁止硬编码——所见一切来自 tokens.css。</p>
      </div>
      <div class="hd-ctl">
        <DSegmented options={[{ value: 'dark', label: '暗色' }, { value: 'light', label: '亮色' }]} bind:value={theme} />
      </div>
    </header>

    <div class="grid">
      <section class="card">
        <h3>按钮 DButton</h3>
        <div class="line-demo">
          <DButton variant="primary">主操作</DButton>
          <DButton>次级</DButton>
          <DButton variant="ghost">幽灵</DButton>
          <DButton variant="danger">危险</DButton>
        </div>
        <div class="line-demo">
          <DButton variant="primary" size="sm">小主操作</DButton>
          <DButton size="sm">小次级</DButton>
          <DButton variant="primary" disabled>禁用</DButton>
          <DButton disabled>禁用</DButton>
        </div>
      </section>

      <section class="card">
        <h3>开关 DSwitch</h3>
        <div class="line-demo">
          <label class="lab"><DSwitch bind:checked={sw1} /> 开 ({sw1 ? 'on' : 'off'})</label>
          <label class="lab"><DSwitch bind:checked={sw2} /> 关 ({sw2 ? 'on' : 'off'})</label>
          <label class="lab"><DSwitch bind:checked={sw3} disabled /> 禁用</label>
        </div>
      </section>

      <section class="card">
        <h3>分段 DSegmented</h3>
        <DSegmented options={SEG_OPTS} bind:value={seg} />
        <p class="ro">当前：{seg}</p>
        <DSegmented options={SEG_OPTS} value="balanced" disabled />
      </section>

      <section class="card">
        <h3>滑杆 DSlider</h3>
        <div class="sld-line"><DSlider bind:value={sld1} /><span class="ro">{sld1}</span></div>
        <div class="sld-line"><DSlider bind:value={sld2} min={0} max={200} step={2} /><span class="ro">{sld2}</span></div>
        <div class="sld-line"><DSlider value={30} disabled /><span class="ro">禁用</span></div>
      </section>

      <section class="card">
        <h3>下拉 DSelect</h3>
        <div class="line-demo">
          <DSelect options={MODEL_OPTS} bind:value={sel} width="180px" />
          <DSelect options={MODEL_OPTS} value="opus" disabled width="140px" />
        </div>
        <p class="ro">当前：{sel}</p>
      </section>

      <section class="card">
        <h3>输入 DField · 提示 tooltip</h3>
        <div class="line-demo">
          <DField bind:value={fld} placeholder="服务器地址…" width="200px" />
          <DButton title="" onclick={() => {}}><span use:tooltip={'悬停 380ms 出现，自动避开屏幕边缘'}>悬停看提示</span></DButton>
        </div>
        <p class="ro">输入：{fld || '—'}</p>
      </section>

      <section class="card wide">
        <h3>分组列表 DGroup / DRow（设置页解剖）</h3>
        <div class="two-col">
          <DGroup label="通用" foot="通知走系统通知中心；跑完或等回答时提醒。">
            <DRow title="通知" sub="任务完成 / 等你回答" chip="#e0483e">
              {#snippet icon()}<svg viewBox="0 0 22 22" width="15" height="15"><path d="M11 3a5.5 5.5 0 0 0-5.5 5.5c0 3.6-1.3 5-1.3 5h13.6s-1.3-1.4-1.3-5A5.5 5.5 0 0 0 11 3zM9.4 16.5a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>{/snippet}
              {#snippet trailing()}<DSwitch bind:checked={notif} />{/snippet}
            </DRow>
            <DRow title="画质" chip="#bf5af2">
              {#snippet icon()}<svg viewBox="0 0 22 22" width="15" height="15"><rect x="4" y="5" width="14" height="10" rx="2" fill="none" stroke="#fff" stroke-width="1.7"/><path d="M8 18h6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>{/snippet}
              {#snippet trailing()}<DSegmented options={QUALITY_OPTS} bind:value={quality} />{/snippet}
            </DRow>
          </DGroup>
          <DGroup label="连接" foot="可点行：hover 增亮 + 右侧 chevron，键盘 focus 有环。">
            <DRow title="服务器地址" sub="https://bridge.example.com" chip="#34c759" onclick={() => {}}>
              {#snippet icon()}<svg viewBox="0 0 22 22" width="15" height="15"><ellipse cx="11" cy="11" rx="7" ry="7" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M4 11h14M11 4c2.5 2.3 2.5 11.7 0 14-2.5-2.3-2.5-11.7 0-14z" fill="none" stroke="#fff" stroke-width="1.6"/></svg>{/snippet}
              {#snippet trailing()}<span>隧道</span>{/snippet}
            </DRow>
            <DRow title="检查更新" sub="当前 2026.07.22" chip="#ff9f0a" onclick={() => {}}>
              {#snippet icon()}<svg viewBox="0 0 22 22" width="15" height="15"><path d="M11 4v9m0 0-3.5-3.5M11 13l3.5-3.5M5 17h12" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>{/snippet}
            </DRow>
            <DRow title="退出登录" danger onclick={() => {}} />
          </DGroup>
        </div>
      </section>

      <section class="card wide">
        <h3>令牌 · 色板 / 圆角 / 层级</h3>
        <div class="sw-grid">
          {#each SWATCHES as [name, v] (v)}
            <div class="swatch"><span class="chipk" style:background="var({v})"></span><span class="swl">{name}</span></div>
          {/each}
        </div>
        <div class="ramp">
          {#each RADII as [name, v] (v)}
            <div class="rbox" style:border-radius="var({v})"><span>{name}</span></div>
          {/each}
          {#each SHADOWS as [name, v] (v)}
            <div class="sbox" style:box-shadow="var({v})"><span>{name}</span></div>
          {/each}
        </div>
      </section>

      <section class="card wide">
        <h3>材质 · DOM 假玻璃令牌（真折射归批2 GL 引擎）</h3>
        <div class="glass-stage">
          <div class="glass-card">
            <b>玻璃面板</b>
            <span>fill + stroke + 顶部内高光，全部来自 --dsk-glass-*</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .gal {
    position: fixed; inset: 0; overflow: auto;
    background: var(--dsk-bg); color: var(--dsk-ink);
    font-family: var(--dsk-font); font-size: var(--dsk-fs-ui);
    transition: background var(--dsk-t-slow) var(--dsk-ease);
  }
  .wrap { max-width: 1020px; margin: 0 auto; padding: var(--dsk-s8) var(--dsk-s6) 80px; }
  .hd { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--dsk-s4); margin-bottom: var(--dsk-s6); }
  .hd h1 { font-size: var(--dsk-fs-hero); font-weight: 700; letter-spacing: -.01em; margin: 0 0 6px; }
  .hd p { margin: 0; color: var(--dsk-ink-2); font-size: var(--dsk-fs-body); }
  .hd-ctl { flex: none; width: 160px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--dsk-s4); }
  .card {
    background: var(--dsk-panel); border-radius: var(--dsk-r-lg); box-shadow: var(--dsk-sh-1);
    padding: var(--dsk-s5); display: flex; flex-direction: column; gap: var(--dsk-s3);
  }
  .card.wide { grid-column: 1 / -1; }
  .card h3 {
    margin: 0; font-size: var(--dsk-fs-caption); font-weight: 600;
    letter-spacing: .07em; color: var(--dsk-ink-3); text-transform: uppercase;
  }
  .line-demo { display: flex; align-items: center; gap: var(--dsk-s2); flex-wrap: wrap; }
  .lab { display: inline-flex; align-items: center; gap: var(--dsk-s2); color: var(--dsk-ink-2); font-size: var(--dsk-fs-sm); }
  .ro { margin: 0; color: var(--dsk-ink-3); font-size: var(--dsk-fs-sm); }
  .sld-line { display: flex; align-items: center; gap: var(--dsk-s3); }
  .sld-line .ro { width: 42px; flex: none; text-align: right; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--dsk-s4); align-items: start; }
  @media (max-width: 760px) { .two-col { grid-template-columns: 1fr; } }

  .sw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: var(--dsk-s2); }
  .swatch { display: flex; align-items: center; gap: var(--dsk-s2); }
  .chipk { width: 26px; height: 26px; border-radius: var(--dsk-r-xs); box-shadow: inset 0 0 0 1px var(--dsk-line-strong); flex: none; }
  .swl { font-size: var(--dsk-fs-sm); color: var(--dsk-ink-2); }
  .ramp { display: flex; gap: var(--dsk-s3); flex-wrap: wrap; align-items: center; }
  .rbox, .sbox {
    width: 72px; height: 52px; display: grid; place-items: center;
    background: var(--dsk-panel-strong); font-size: var(--dsk-fs-caption); color: var(--dsk-ink-3);
  }
  .rbox { box-shadow: 0 0 0 1px var(--dsk-line-strong); }
  .sbox { border-radius: var(--dsk-r-md); background: var(--dsk-bg-raised); }

  .glass-stage {
    border-radius: var(--dsk-r-lg); padding: var(--dsk-s7); display: grid; place-items: center;
    background:
      radial-gradient(120% 160% at 12% 8%, #3a5ba0 0%, transparent 55%),
      radial-gradient(130% 140% at 88% 20%, #b0563a 0%, transparent 52%),
      radial-gradient(120% 150% at 55% 100%, #276352 0%, transparent 60%),
      #14140f;
  }
  .glass-card {
    display: flex; flex-direction: column; gap: 4px; align-items: center; text-align: center;
    padding: var(--dsk-s5) var(--dsk-s7); border-radius: var(--dsk-r-xl);
    background: var(--dsk-glass-fill);
    box-shadow:
      inset 0 0 0 1px var(--dsk-glass-stroke),
      inset 0 1.5px 0 var(--dsk-glass-hi),
      0 14px 38px rgba(0, 0, 0, .35);
    -webkit-backdrop-filter: blur(14px) saturate(1.3);
    backdrop-filter: blur(14px) saturate(1.3);
    color: #fff;
  }
  .glass-card b { font-size: var(--dsk-fs-md); }
  .glass-card span { font-size: var(--dsk-fs-sm); opacity: .75; }
</style>
