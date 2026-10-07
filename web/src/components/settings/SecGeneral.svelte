<script>
  // 设置 · 通用：外观（主题三态 + 界面语言）、通知、输入建议、图片原图加载。
  // 读写键：bridge-prefs（followSys / promptSuggest / fullResMedia）、bridge-notify、bridge-theme。
  import { ui, prefs, savePrefs, applyFollowSys, setTheme } from '../../lib/state.svelte.js';
  import { t, tc, lang, setLang, LANGS } from '../../lib/i18n.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SToggle from './SToggle.svelte';
  import SSegmented from './SSegmented.svelte';

  // —— 主题：跟随系统 / 浅色 / 深色（claude.ai 设置同款三图标分段）——
  const themeVal = $derived(prefs.followSys ? 'system' : ui.theme);
  function setThemeMode(v) {
    if (v === 'system') { prefs.followSys = true; savePrefs(); applyFollowSys(); return; }
    prefs.followSys = false; savePrefs(); setTheme(v);
  }
  const MONITOR = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="3.6" width="14.8" height="9.9" rx="1.6"/><path d="M7.4 16.4h5.2M10 13.5v2.9"/></svg>';
  const THEME_OPTS = [
    { value: 'system', svg: MONITOR, title: t('跟随系统') },
    { value: 'light', icon: '', title: t('浅色') },
    { value: 'dark', icon: '', title: t('深色') },
  ];

  // —— 通知（浏览器通知，见 lib/notify.js）——
  const load = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v === '1'; } catch { return def; } };
  let notifyOn = $state(load('bridge-notify', true));
  function onNotify(v) {
    notifyOn = v;
    try { localStorage.setItem('bridge-notify', v ? '1' : '0'); } catch {}
    // 打开时顺手向浏览器要通知权限（只有用户手势里才能弹授权框）
    try { if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
  }

  function onFullRes(v) { prefs.fullResMedia = v; savePrefs(); }
  function onSuggest(v) { prefs.promptSuggest = v; savePrefs(); }
  const MARK_OPTS = [{ value: 'clay', label: t('新版 Claude Code') }, { value: 'sprite', label: t('新版聊天页') }, { value: 'classic', label: t('经典星标') }];
  function onMark(v) { prefs.claudeMark = v; savePrefs(); }
</script>

<SSection title={t('外观')}>
  <SRow label={t('主题')} sid="theme">
    {#snippet trailing()}<SSegmented options={THEME_OPTS} value={themeVal} onchange={setThemeMode} label={t('主题')} />{/snippet}
  </SRow>
  <!-- 界面语言（claude.ai 设置同位置）：语言名用本族语写；选中即整页重载 -->
  <SRow label={t('语言')} desc={t('切换后界面会重新加载')} sid="lang">
    {#snippet trailing()}<SSegmented options={LANGS} value={lang()} onchange={setLang} label={t('界面语言')} />{/snippet}
  </SRow>
</SSection>

<SSection title={t('通知')}>
  <SRow label={t('任务通知')} desc={t('任务跑完、或 Claude 在等你回答时提醒；正开着这个页面时不打扰')} sid="notify">
    {#snippet trailing()}<SToggle checked={notifyOn} onchange={onNotify} label={t('任务通知')} />{/snippet}
  </SRow>
</SSection>

<SSection title={t('对话')}>
  <SRow label={t('输入建议')} desc={t('每次回复完猜你接下来想说的话，输入框空着时以灰字显示；点「填入」（电脑上按 Tab）放进输入框')} sid="suggest">
    {#snippet trailing()}<SToggle checked={prefs.promptSuggest} onchange={onSuggest} label={t('输入建议')} />{/snippet}
  </SRow>
  <SRow label={t('思考动画')} desc={t('回复进行中的 Claude 标记：Claude Code 版按正在做的事换动画，聊天页版是星形散成节点，经典是原来的星标')} sid="thinkmark">
    {#snippet trailing()}<SSegmented options={MARK_OPTS} value={prefs.claudeMark} onchange={onMark} label={t('思考动画')} />{/snippet}
  </SRow>
</SSection>

<SSection title={tc('settings', '图片')}>
  <SRow label={t('原图加载')} desc={t('看图直接加载原图，最清晰但费流量；关掉时先看 1280px 轻量图，放大再换原图')} sid="fullres">
    {#snippet trailing()}<SToggle checked={prefs.fullResMedia} onchange={onFullRes} label={t('原图加载')} />{/snippet}
  </SRow>
</SSection>

