<script>
  // 设置 › Claude › 对话 › 子 agent 调用策略（子页正文）。两套设置外壳共用这一份：
  //   shell='desk' 桌面壳（desktop/settings/SettingsDesktop，读 --dsk-*）；shell='ios' 手机 / 网页壳（components/Settings，读 --i-*）。
  //   根上把两套令牌统一成 --dp-*（先例 studio/settings/StudioSettings.svelte），子组件只读这一组；四档的颜色（--dp-t-*）
  //   取状态模块的 tierColorVars（和性价比图同一份色值），整页只有它们和数据点是彩色的。
  //   类名一律 dp- / 各子组件自己的前缀：两套外壳都有带 :global 的 .grp / .gcard / .drow / .r 规则，撞名会把外壳样式串进来。
  //
  // 自上而下：总开关（关着时一句说明）→ 生效范围 → 策略栏 → 〔当前查看的这一套〕四档落点、性价比图、口述备注 → 优先级示意 → 保存条。
  //   即点即存：总开关、生效范围、「调用非 Claude 模型」、设为生效、新建 / 复制 / 删除；
  //   进保存条：当前这一套的判定线、档位自定义、备注、名字（只改名字且没有别的改动时，改名确认即存）。
  //
  // 草稿与预览：draft 是当前这一套可改内容的拷贝，base 是服务端那份。四档落点与图上的环优先用服务端的预览
  //   （previewStrategy，不落盘）；应答回来之前、以及拖判定线的过程中，先按同一条规则在本地算（dpUtil.estimateTiers），手上不等。
  //
  // 离开：切到别的策略 / 新建之前有未保存的改动 → 应用内对话框先问「保存 / 不保存」，选不保存再确认「放弃改动 / 继续编辑」
  //   （uiConfirm 只有两个按钮，三个去向分两步问；Esc 永远落在「继续编辑」上，不会误丢）。
  //   离开子页由外壳决定：外壳可以先 await leaveGuard.js 的 dispatchLeaveGuard()；没接的话，卸载时发现还有改动会补问一次「保存 / 放弃」。
  //
  // 浮层（模型菜单、推理强度面板、小菜单）都挪到 body 上（手机设置页的面板带 transform，fixed 浮层出不来）；
  // 开着时经 onModal 告诉外壳。
  //
  // 作用域（store）：同一份正文也是 设置 › dimensio › 子 agent 调用策略。dimensio 那份多一个「策略来源」：跟随 Claude 的策略（缺省）时
  //   只读地摆出 Claude 生效的那一套在 dimensio 候选上的落点（备注也是那一套的），给一个去 Claude 子页的入口；单独一套时和 Claude 一样整套可改。
  //   dimensio 没有「主对话」口径分段；档位自定义的型号写法是 <厂商>:<型号>，落点表里用小菜单选（TierTable 的 dimensio 分支）。
  //
  // 名字：策略名给人看的地方（策略签、保存条、确认框、提示条、复制出来的名字）一律过 dpLabels.strategyLabel——迁移出来的那一套
  //   存的名字是「默认」，界面上跟着语言走，和外壳入口副标题一致；存盘、比较还用原名。
  // 防连点：新建 / 复制在途时再点不理（落定后的一小会儿也不理，双击的第二下常落在这儿）；连点别的策略签只问一轮「要保存吗」，
  //   落定后切到最后点的那一套。
  import { onMount, onDestroy, untrack } from 'svelte';
  import DSegmented from '../../../desktop/kit/DSegmented.svelte';
  import Segmented from '../../ios27/Segmented.svelte';
  import DpSwitch from './DpSwitch.svelte';
  import ScopeCard from './ScopeCard.svelte';
  import StrategyBar from './StrategyBar.svelte';
  import TierTable from './TierTable.svelte';
  import ChartCard from './ChartCard.svelte';
  import NoteCard from './NoteCard.svelte';
  import { claudeDispatch, tierColorVars } from '../../../lib/dispatchPolicy.svelte.js';
  import { cp, ensureCustomModels } from '../../../lib/claudeProviders.svelte.js';
  import { openSettings } from '../../../lib/settingsNav.svelte.js';
  import { caps, ui } from '../../../lib/state.svelte.js';
  import { splitClaudeModels, loadCaps } from '../../../lib/caps.js';
  import { uiConfirm, uiAlert } from '../../../lib/dialogs.js';
  import { showToast } from '../../../lib/toast.svelte.js';
  import { DUR, EASE, reduced } from '../../../lib/motion.js';
  import { t, tr } from '../../../lib/i18n.js';
  import { setDispatchLeaveGuard } from './leaveGuard.js';
  import {
    TIER_KEYS, STRATEGY_MAX, NAME_MAX, draftOf, draftDiff, sameDraft, strategyPayload, hasFloorEdits,
    clipName, uniqueName, estimateTiers, chartTiersOf, sharedFlight, singleFlight, latestAfter,
  } from './dpUtil.js';
  import { strategyLabel } from './dpLabels.js';
  import { clampFloor, roundFloor } from '../../../lib/dispatchChartMath.js';

  // store：哪一份调用策略（lib/dispatchPolicy 的 createDispatchStore；不给 = Claude 那份）。挂上就不换：外壳换作用域时整个重挂。
  let { shell = 'desk', onModal = () => {}, store = claudeDispatch } = $props();
  const S = untrack(() => store);
  const { dp, loadDispatch, setDispatch, saveStrategy, deleteStrategy, previewStrategy, setBasis } = S;
  // dimensio 那份（设置 › dimensio › 子 agent 调用策略）：总开关下面多一个「跟随 Claude 的策略 / dimensio 单独一套」；
  //   跟随时生效的那一套取 Claude 那边生效的那套（判定线、档位自定义、口述备注），这里只读地摆出它按 dimensio 能用的模型算出的落点，
  //   改要去 Claude 的子页；单独时下面是和 Claude 一样的整套编辑器。范围三项换成 dimensio 的说法，没有「主对话」口径分段。
  const dim = S.scope === 'dimensio';
  const desk = $derived(shell !== 'ios');
  const dark = $derived(ui.theme !== 'light');   // 两套外壳的明暗都跟 ui.theme

  // —— 服务端那份 ——
  const policy = $derived(dp.policy);
  const strategies = $derived(policy?.strategies || []);
  const activeId = $derived(policy?.activeId || '');
  const enabled = $derived(policy?.enabled !== false);
  const allowTP = $derived(policy?.allowThirdParty !== false);
  const canEdit = $derived(!!dp.canEdit);
  // dimensio：跟随 Claude 的策略（缺省就是跟随）。这时下面的落点 / 图 / 备注只读，「调用非 Claude 模型」仍是 dimensio 自己的、照样能拨
  const follow = $derived(dim && policy?.follow !== false);
  const canEditBody = $derived(canEdit && !follow);
  const claudeSide = $derived(dim ? dp.claude || null : null);   // Claude 那边生效的那一套 { activeId, name, … }
  const primary = $derived(splitClaudeModels(caps.data).primary);   // 四个有别名的 Claude 模型（opus / sonnet / haiku / fable）

  // —— 当前查看的那一套 ——
  // 再次进来时策略已经在手里：视图与草稿当场按生效的那一套起好，第一帧就是对的（不等 effect 再闪一下）
  const first = (() => { const list = dp.policy?.strategies || []; return list.find((s) => s.id === dp.policy?.activeId) || list[0] || null; })();
  let viewId = $state(first?.id || '');
  let wantView = '';   // 刚新建的那一套：等它出现在列表里再切过去（非响应式）
  $effect(() => {
    const list = strategies;
    untrack(() => {
      if (wantView && list.some((s) => s.id === wantView)) { viewId = wantView; wantView = ''; return; }
      // 正在看的那一套没了（在别的设备上删了）→ 回到生效的那一套
      if (!list.some((s) => s.id === viewId)) viewId = (list.find((s) => s.id === activeId) || list[0])?.id || '';
    });
  });
  const viewed = $derived(strategies.find((s) => s.id === viewId) || strategies.find((s) => s.id === activeId) || strategies[0] || null);
  const curId = $derived(viewed?.id || '');

  // —— 草稿 ——
  let base = $state(draftOf(first));
  let draft = $state(draftOf(first));
  let seeded = first ? JSON.stringify(draftOf(first)) : '';   // 上次按服务端哪一份播的种（非响应式）
  $effect(() => {
    const s = viewed;
    if (!s) return;
    const fresh = draftOf(s);
    const stamp = JSON.stringify(fresh);
    untrack(() => {
      if (stamp === seeded) return;
      // 还是同一套、本地有没保存的改动（别的设备改了它、或只是 rev 变了）：只换基线，草稿留着
      const keep = base.id === fresh.id && !sameDraft(draft, base);
      seeded = stamp;
      base = fresh;
      if (!keep) draft = draftOf(s);
    });
  });
  const diff = $derived(draftDiff(draft, base));
  const dirty = $derived(canEditBody && !!draft.id && diff.any);
  const rawName = $derived(draft.name || base.name);       // 存下来 / 草稿里的原名：给策略栏比较、回传用
  const shownName = $derived(strategyLabel(rawName));      // 给人看的写法：保存条、确认框、提示条

  // —— 预览 ——
  // 服务端预览跟这几样有关：哪一套、判定线、档位自定义、是否调用非 Claude、口径、图谱版本（备注与名字不影响落点）
  const pvSig = $derived(JSON.stringify([draft.id, draft.floors, draft.overrides, allowTP, dp.basis,
    dp.preview?.chart?.generated ?? '', dp.preview?.chart?.at ?? '', dp.preview?.chart?.source ?? '']));
  // 看的就是生效的那一套、落点相关的没改过：GET 带回来的预览就是它
  const useGlobal = $derived(follow || (!!draft.id && draft.id === activeId && !diff.floors && !diff.overrides));
  let pvLocal = $state.raw(null);   // { sig, data }
  $effect(() => {
    const sig = pvSig;
    if (!dp.loaded || useGlobal || !untrack(() => draft.id)) return;
    const payload = untrack(() => strategyPayload($state.snapshot(draft)));
    const tp = untrack(() => allowTP);
    let dead = false;
    Promise.resolve()
      .then(() => previewStrategy(payload, { allowThirdParty: tp }))
      .then((data) => { if (!dead && data && Array.isArray(data.tiers)) pvLocal = { sig, data }; })
      .catch(() => {});
    return () => { dead = true; };
  });
  const pvFresh = $derived(useGlobal ? dp.preview : (pvLocal && pvLocal.sig === pvSig ? pvLocal.data : null));
  const pvAny = $derived(pvFresh || pvLocal?.data || dp.preview);   // 候选点、默认线：新的没到就先用手头的
  const candidates = $derived(pvAny?.candidates || []);
  const unrated = $derived(pvAny?.unrated || []);
  let dragging = $state(false);     // 正在拖判定线：这期间只用本地预估，免得半路回来的应答把线和环拽回去
  let bodyEl = $state();            // 当前这一套的三张卡（落点 / 图 / 备注）所在的那一层
  const tiers = $derived.by(() => {
    const src = pvFresh && !dragging
      ? (pvFresh.tiers || []).filter((x) => x && x.pick)
      : estimateTiers(pvAny?.tiers, candidates, draft);
    return src.map((x) => {
      const floorDefault = Number.isFinite(x.floorDefault) ? x.floorDefault : x.floor;
      if (follow) {
        // 跟随 Claude 的策略：没有草稿，一切照服务端按 Claude 那一套算出来的（判定线、哪档是指定的、哪档的指定在 dimensio 里用不了）
        const ov = claudeSide?.overrides?.[x.key] || null;
        return {
          key: x.key, floor: x.floor, floorDefault, adjusted: x.floor !== floorDefault,
          pick: x.pick, source: x.source === 'override' ? 'override' : 'chart', short: !!x.short,
          hasOverride: x.source === 'override' || !!x.overrideSkipped, overrideSkipped: !!x.overrideSkipped,
          override: ov && ov.model ? ov : null, agentTool: null,
        };
      }
      const mine = draft.floors[x.key];
      return {
        key: x.key, floor: mine != null ? mine : floorDefault, floorDefault, adjusted: mine != null,
        pick: x.pick, source: x.source === 'override' ? 'override' : 'chart', short: !!x.short,
        hasOverride: !!draft.overrides[x.key], overrideSkipped: !!draft.overrides[x.key] && x.source !== 'override',
        override: draft.overrides[x.key], agentTool: x.agentTool || null,
      };
    });
  });
  // 给图的那份落点要带全（智力分 / 成本 / 显示名 / 计费口径，外加借来的 creator）：档位自定义落在候选里没有的格子上时，图靠它们补虚点
  const chartTiers = $derived(chartTiersOf(tiers, candidates));

  // 拖动没走到「松手」那一步就断了（指针被系统收走）：图在结束时会冒泡 dp-drag(false)，这里据此收尾
  $effect(() => {
    const el = bodyEl;
    if (!el) return;
    const h = (e) => { if (e.detail === false) dragging = false; };
    el.addEventListener('dp-drag', h);
    return () => el.removeEventListener('dp-drag', h);
  });

  // —— 改草稿 ——
  function onFloor(key, value, info) {
    if (!canEditBody || !TIER_KEYS.includes(key) || !Number.isFinite(value)) return;
    dragging = !(info && info.final);
    // 四条线保持 最难 ≥ 难 ≥ 常规 ≥ 机械（图里拖不过去，这里再兜一道：服务端保存时不满足会拒）
    const now = {};
    for (const x of tiers) now[x.key] = x.floor;
    const v = clampFloor(key, value, now, { gap: 0 });
    const def = tiers.find((x) => x.key === key)?.floorDefault;
    draft.floors[key] = Number.isFinite(def) && v === roundFloor(def) ? null : v;   // 拖回默认线上 = 没调过
  }
  function onReset(key) { if (canEditBody && TIER_KEYS.includes(key)) { dragging = false; draft.floors[key] = null; } }
  function resetFloors() { if (!canEditBody) return; dragging = false; for (const k of TIER_KEYS) draft.floors[k] = null; }
  function setOverride(key, ov) {
    if (!canEditBody || !TIER_KEYS.includes(key)) return;
    draft.overrides[key] = ov && ov.model ? { model: ov.model, effort: ov.effort || '' } : null;
  }

  // —— 保存 / 放弃 ——
  // 卸载时要补问的那份草稿（非响应式）：由「进出」那里的 effect 跟着草稿更新；存好 / 放弃的那一下当场清掉，
  // 免得外壳紧接着卸载子页时 effect 还没跑、又补问一次
  let leaving = null;
  const failText = (e, fb) => tr((e && e.message) || '') || fb;
  let saving = $state(false);
  let saveErr = $state('');
  $effect(() => { if (!dirty) saveErr = ''; });
  let saveP = null;   // 正在路上的那次保存：再点一次保存 / Ctrl+S 都等它，不重复发
  function save() {
    if (saveP) return saveP;
    if (!dirty) return Promise.resolve(true);
    saveP = doSave().finally(() => { saveP = null; });
    return saveP;
  }
  async function doSave() {
    if (!clipName(draft.name)) draft.name = base.name;
    const sent = $state.snapshot(draft);
    saving = true; saveErr = '';
    try {
      const saved = (await saveStrategy(strategyPayload(sent))) || strategies.find((s) => s.id === sent.id);
      const fresh = draftOf(saved);
      // 保存期间又改了别的（备注里接着打字）：那部分留在草稿里，基线换成刚存的
      seeded = JSON.stringify(fresh);
      base = fresh;
      if (sameDraft(draft, sent)) { draft = draftOf(saved); leaving = null; }
      return true;
    } catch (e) {
      saveErr = failText(e, t('没保存成'));
      return false;
    } finally {
      saving = false;
    }
  }
  function discard() { dragging = false; saveErr = ''; draft = draftOf($state.snapshot(base)); leaving = null; }

  // 有未保存的改动时要先有个说法。回 true = 可以继续（没有改动 / 存好了 / 放弃了），false = 留在这儿。
  // 一次只问一轮：正问着的时候别处又来问（连点策略签、点了签又点复制、外壳这时要退出子页），都等同一个结果，
  // 不往对话框队列里再排一轮同样的话。
  const settleUnsaved = sharedFlight(askUnsaved);
  async function askUnsaved() {
    if (saveP) await saveP;   // 改名确认触发的那次保存还在路上：等它落定，再看还有没有没存的
    if (!dirty) return true;
    const name = shownName;
    if (await uiConfirm(t('要保存对「{name}」的改动吗？', { name }), { okLabel: t('保存'), cancelLabel: t('不保存') })) return save();
    const drop = await uiConfirm(t('放弃对「{name}」的改动？', { name }),
      { detail: t('判定线、档位自定义和备注会回到上次保存的样子。'), okLabel: t('放弃改动'), cancelLabel: t('继续编辑'), danger: true });
    if (!drop) return false;
    discard();
    return true;
  }

  // —— 即点即存的几样 ——
  async function patch(p) {
    try { await setDispatch(p); }
    catch (e) { showToast(failText(e, t('没改成')), 'err'); }
  }

  // —— 策略栏 ——
  function swapFx() {
    // 换一套看：下面三张卡的内容一起换场（只动 opacity 与 6px 位移）
    if (!bodyEl || reduced()) return;
    bodyEl.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.base, easing: EASE.decel });
  }
  function show(id) {
    if (strategies.some((s) => s.id === id)) viewId = id; else wantView = id;
    swapFx();
  }
  // 点一枚策略签：先过「要保存吗」再切。还在问的时候又点了别的签——只把目标换成后点的那一套，落定后切过去（不再问一轮）
  const viewGo = latestAfter(settleUnsaved, (id) => { if (id !== curId && strategies.some((s) => s.id === id)) show(id); });
  function view(id) {
    if (!strategies.some((s) => s.id === id)) return undefined;
    if (id === curId && !viewGo.busy()) return undefined;
    return viewGo(id);
  }
  async function activate() {
    const s = viewed;
    if (!s || s.id === activeId) return;
    try { await setDispatch({ activeId: s.id }); showToast(t('「{name}」已生效', { name: strategyLabel(s.name) })); }
    catch (e) { showToast(failText(e, t('没改成')), 'err'); }
  }
  let renameTick = $state(0);   // 新建 / 复制成功后 +1：策略栏等 renameId 那一套成了当前这一套，直接进入改名
  let renameId = $state('');
  // 新建 / 复制没有别的去重（请求不串行、服务端同名照收）：连点两下就是两套。在途时再点不理；落定后 400ms 里也不理——
  // 请求回得快的时候，双击的第二下落在第一下已经办完之后，那时当前这一套已经是刚建的副本，会再复制出一套「…副本 副本」。
  let creating = $state(false);
  const createOnce = singleFlight({ cool: 400 });
  function create(mode) {
    if (!canEditBody || strategies.length >= STRATEGY_MAX) return undefined;
    return createOnce(async () => {
      creating = true;
      try { await doCreate(mode); } finally { creating = false; }
    });
  }
  async function doCreate(mode) {
    if (!(await settleUnsaved())) return;
    const names = strategies.map((s) => s.name);
    const src = viewed;
    // 副本的名字从显示的那个写法起（英文界面下复制「默认」那一套得到「Default copy」，不是「默认 copy」）
    const stem = [...(src ? strategyLabel(src.name) : '')].slice(0, NAME_MAX - 6).join('').trim();
    const copy = mode === 'copy' && !!src;
    const name = copy
      ? uniqueName(names, (n) => (n > 1 ? t('{name} 副本 {n}', { name: stem, n }) : t('{name} 副本', { name: stem })))
      : uniqueName(names, (n) => t('策略 {n}', { n: strategies.length + n }));
    try {
      const made = copy
        ? await saveStrategy({ name }, { copyOf: src.id })
        : await saveStrategy(strategyPayload({ ...draftOf(null), name }));
      const id = made?.id || (dp.policy?.strategies || []).find((s) => s.name === name && !names.includes(s.name))?.id;
      if (id) { show(id); renameId = id; renameTick++; }
    } catch (e) {
      showToast(failText(e, t('没建成')), 'err');
    }
  }
  // 改名：确认后写进草稿。此刻没有别的未保存改动 → 直接存（改名本身就是一步完整的操作）；
  // 有别的改动 → 跟它们一起留在保存条里。存失败时名字留在草稿里，保存条会升起来、带着报错。
  async function rename(name) {
    const n = clipName(name);
    if (!canEditBody || !n || n === draft.name) return;
    const others = diff.floors || diff.overrides || diff.note;
    draft.name = n;
    if (!others) await save();
  }
  async function remove() {
    const s = viewed;
    if (!canEditBody || !s || s.id === activeId) return;
    const name = strategyLabel(s.name);
    const ok = await uiConfirm(t('删除策略「{name}」？', { name }), { detail: t('删除后不能恢复。'), okLabel: t('删除'), danger: true });
    if (!ok) return;
    try {
      await deleteStrategy(s.id);
      show(dp.policy?.activeId || '');
      showToast(t('已删除「{name}」', { name }));
    } catch (e) {
      showToast(failText(e, t('没删掉')), 'err');
    }
  }

  // —— 口径（主对话是 Claude 订阅还是自定义 API）：没有任何自定义模型时不出现；dimensio 那份没有这一说 ——
  const hasCustom = $derived(!dim && cp.models.length > 0);
  const BASIS = [{ value: 'official', label: t('Claude 订阅') }, { value: 'custom', label: t('自定义 API') }];
  async function pickBasis(v) {
    if (v === dp.basis) return;
    try { await setBasis(v); } catch (e) { showToast(failText(e, t('读不到这个口径的落点')), 'err'); }
  }
  // 自定义模型全删了而口径还停在「自定义 API」：分段不出现了，自己退回订阅口径
  $effect(() => { if (!dim && dp.loaded && cp.modelsReady && !hasCustom && dp.basis === 'custom') setBasis('official').catch(() => {}); });

  // —— dimensio：跟随 Claude 的策略 / 单独一套（即点即存） ——
  // 从「单独」切到「跟随」之前，当前这一套没保存的改动先有个说法（保存 / 放弃），不然它们在跟随的这段时间里看不见、切回来又冒出来
  const SOURCE = [{ value: 'follow', label: t('跟随 Claude 的策略') }, { value: 'own', label: t('dimensio 单独一套') }];
  let sourceBusy = $state(false);
  async function pickSource(v) {
    const want = v === 'follow';
    if (!dim || !canEdit || want === follow || sourceBusy) return;
    sourceBusy = true;
    try {
      if (want && !(await settleUnsaved())) return;
      await setDispatch({ follow: want });
    } catch (e) { showToast(failText(e, t('没改成')), 'err'); }
    finally { sourceBusy = false; }
  }
  // Claude 那边生效的那一套叫什么（迁移出来的「默认」跟着界面语言走）
  const claudeName = $derived(claudeSide ? strategyLabel(claudeSide.name || '') : '');
  // 去 Claude 的子 agent 调用策略子页改：两套外壳都认 openSettings('dispatch')（桌面落到 Claude 分区的就地子页，手机推到 cl-dispatch）
  const goClaude = () => openSettings('dispatch');
  // 生效范围三枚片的 dimensio 说法
  const DIM_SCOPE = [
    { key: 'workflow', name: t('工作流'), sub: t('Workflow 工具脚本里的 agent()') },
    { key: 'subagent', name: t('普通子 agent'), sub: t('对话里用 Agent 工具派出的') },
    { key: 'session', name: t('发起新会话'), sub: t('StartSession 的模型可以写 auto:<档>') },
  ];
  // 落点算不出来时（harness 没起来等）四档表与图里的那句话
  // 预览在、但四档是空的（这台 dimensio 眼下没有评上分的可用型号）：另一句
  const noPreview = $derived(!dim ? ''
    : !dp.preview ? tr(dp.previewError || '') || t('dimensio 暂时算不出落点，稍后再来看')
    : !(dp.preview.tiers || []).length ? t('dimensio 此刻没有评上分的可用模型，四档暂时排不出落点')
    : '');

  // —— 浮层登记（外壳据此让出 Esc / 手势） ——
  const modals = $state({ bar: false, tier: false, chart: false });
  $effect(() => { onModal(modals.bar || modals.tier || modals.chart); });

  // —— 进出 ——
  $effect(() => { leaving = dirty ? { payload: strategyPayload($state.snapshot(draft)), name: shownName } : null; });
  onMount(() => {
    // 以前进来过：手里的先用着，后台再拉一次（候选模型、号池的变化不走总线，靠这一次跟上）
    loadDispatch({ force: dp.loaded }).catch(() => {});
    if (!dim) ensureCustomModels();
    // 能力表（Claude 的模型清单与推理强度档位）平时由 App 启动时装好。设置页被单独挂起来的时候（桌面设置的单页验收 ?dsettings）
    // 没人装：别名认不出菜单里的模型，推理强度片退化成点不开的文字、叫法也退回通用的那套。这里补一次，装过了就不动。
    if (!caps.data) loadCaps().then((d) => { if (d && !caps.data) { caps.data = d; caps.loaded = true; } }).catch(() => {});
    return setDispatchLeaveGuard(settleUnsaved, () => dirty);
  });
  onDestroy(() => {
    onModal(false);
    const left = leaving;
    if (!left) return;
    // 外壳没有先问就退出了子页：改动还在手里，补问一次（这时已经不在这一页，只剩「保存 / 放弃」两个去向）
    uiConfirm(t('「{name}」有未保存的改动', { name: left.name }), { detail: t('已经离开这一页。要把刚才的改动保存下来吗？'), okLabel: t('保存'), cancelLabel: t('放弃') })
      .then((ok) => (ok ? saveStrategy(left.payload).then(() => showToast(t('已保存「{name}」', { name: left.name }))) : null))
      .catch((e) => uiAlert(failText(e, t('没保存成')), { type: 'error' }));
  });
  // Ctrl / ⌘ + S：有改动就存
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S') && dirty) { e.preventDefault(); save(); }
  }

  let retrying = $state(false);
  async function retry() {
    if (retrying) return;
    retrying = true;
    try { await loadDispatch({ force: true }); } catch {}
    retrying = false;
  }
  // 保存条第二行：改了哪几样
  const changedText = $derived([diff.name && t('名字'), diff.floors && t('判定线'), diff.overrides && t('档位自定义'), diff.note && t('备注')].filter(Boolean).join(' · '));
</script>

<svelte:window onkeydown={onKey} />

<div class="dp" class:desk class:ios={!desk} class:off={dp.loaded && !enabled} class:dirty style={tierColorVars(dark)}>
  {#if !dp.loaded}
    {#if dp.err && !dp.loading}
      <div class="dp-card dp-msg" role="alert">
        <span class="dp-msg-tx">{tr(dp.err) || t('读不到调用策略')}</span>
        <button type="button" class="dp-btn" disabled={retrying} onclick={retry}>{t('重试')}</button>
      </div>
    {:else}
      <!-- 加载骨架：和正文同样的块面，不闪动的浅底 -->
      <div class="dp-skel" role="status" aria-label={t('正在读取…')}>
        <div class="dp-sk" style:height="52px"></div>
        <div class="dp-sk-row"><div class="dp-sk" style:height="64px"></div><div class="dp-sk" style:height="64px"></div><div class="dp-sk" style:height="64px"></div></div>
        <div class="dp-sk dp-sk-chips"></div>
        <div class="dp-sk" style:height="212px"></div>
        <div class="dp-sk" style:height="320px"></div>
      </div>
    {/if}
  {:else}
    <!-- ① 总开关 + 关着时的说明 -->
    <section class="dp-sec">
      <div class="dp-card">
        <div class="dp-master">
          <span class="dp-master-t">{t('按策略调用')}</span>
          <DpSwitch {shell} checked={enabled} disabled={!canEdit} label={t('按策略调用')} onchange={(v) => patch({ enabled: v })} />
        </div>
        {#if dim}
          <!-- dimensio：生效的那一套从哪来。跟随 = 取 Claude 那边生效的那套（这里只读），单独 = 下面 dimensio 自己的几套 -->
          <div class="dp-src">
            <span class="dp-src-t">{t('策略来源')}</span>
            <span class="dp-src-seg">
              {#if desk}
                <DSegmented options={SOURCE} value={follow ? 'follow' : 'own'} disabled={!canEdit || sourceBusy} onchange={pickSource} />
              {:else}
                <Segmented options={SOURCE} value={follow ? 'follow' : 'own'} size="small" disabled={!canEdit || sourceBusy} label={t('策略来源')} onchange={pickSource} />
              {/if}
            </span>
          </div>
          {#if follow}
            <p class="dp-state dp-follow">
              <span>{claudeName ? t('正在跟随 Claude 的「{name}」：判定线、档位自定义和口述备注都取那一套，落点按 dimensio 此刻能用的模型算。', { name: claudeName })
                : t('正在跟随 Claude 生效的那一套策略：落点按 dimensio 此刻能用的模型算。')}</span>
              {#if claudeSide}<button type="button" class="dp-btn ghost dp-follow-go" onclick={goClaude}>{t('去 Claude 里改')}</button>{/if}
            </p>
          {/if}
        {/if}
        {#if !enabled}
          <p class="dp-state">{dim ? t('已关闭：子 agent 沿用本会话的模型与思考深度') : t('已关闭：子 agent 的模型与推理强度完全由 Claude Code 原生决定')}</p>
        {/if}
        {#if !canEdit}
          <p class="dp-state">{t('当前身份只能查看，不能修改调用策略')}</p>
        {/if}
      </div>
    </section>

    <div class="dp-dim">
      <!-- ② 生效范围 -->
      <section class="dp-sec">
        <h3 class="dp-label">{t('生效范围')}</h3>
        <ScopeCard scope={policy?.scope || {}} {enabled} disabled={!canEdit} items={dim ? DIM_SCOPE : null} onchange={(k, v) => patch({ scope: { [k]: v } })} />
      </section>

      <!-- ③ 策略栏（dimensio 跟随 Claude 的策略时没有自己的几套可选，不出） -->
      {#if !follow}
        <section class="dp-sec dp-sec-bar">
          <h3 class="dp-label">{t('策略')}</h3>
          <StrategyBar {shell} {strategies} {activeId} viewId={curId} name={rawName} canEdit={canEditBody} busy={creating} {renameId} {renameTick}
            onview={view} oncreate={create} onactivate={activate} onrename={rename} ondelete={remove}
            onModal={(v) => { modals.bar = v; }} />
        </section>
      {/if}

      <div class="dp-body" bind:this={bodyEl}>
        <!-- ④ 四档落点 -->
        <section class="dp-sec">
          <div class="dp-label dp-label-row">
            <h3 class="dp-label-t">{t('四档落点')}</h3>
            {#if hasCustom}
              <span class="dp-basis">
                <span class="dp-basis-l">{t('主对话')}</span>
                {#if desk}
                  <span class="dp-basis-seg"><DSegmented options={BASIS} value={dp.basis} onchange={pickBasis} /></span>
                {:else}
                  <span class="dp-basis-seg"><Segmented options={BASIS} value={dp.basis} size="small" label={t('主对话')} onchange={pickBasis} /></span>
                {/if}
              </span>
            {/if}
          </div>
          <TierTable {shell} {tiers} {candidates} {unrated} {primary} canEdit={canEditBody} {allowTP} pending={!pvFresh}
            store={S} {follow} overrideName={claudeDispatch.modelName} emptyText={noPreview}
            onoverride={setOverride} onModal={(v) => { modals.tier = v; }} />
        </section>

        <!-- ⑤ 性价比图 -->
        <section class="dp-sec">
          <h3 class="dp-label">{t('性价比图')}</h3>
          <ChartCard {shell} {candidates} tiers={chartTiers} canEdit={canEditBody} tpEditable={canEdit} {allowTP} chart={pvAny?.chart || dp.preview?.chart || null}
            floorsEdited={!follow && hasFloorEdits(draft)} store={S} emptyHint={noPreview}
            onfloor={onFloor} onreset={onReset} onresetall={resetFloors} onassign={(key, c) => setOverride(key, { model: c.model, effort: c.effort || '' })}
            ontp={(v) => patch({ allowThirdParty: v })} onModal={(v) => { modals.chart = v; }} />
        </section>

        <!-- ⑥ 口述备注（dimensio 跟随时是 Claude 那一套的备注，只读；服务端没给就不出） -->
        {#if !follow || typeof claudeSide?.note === 'string'}
          <section class="dp-sec">
            <div class="dp-label dp-label-row">
              <h3 class="dp-label-t">{t('口述备注')}</h3>
              <span class="dp-label-side">{t('优先级最高，与上面冲突时以这里为准')}</span>
            </div>
            <NoteCard value={follow ? claudeSide.note : draft.note} disabled={!canEditBody} oninput={(v) => { draft.note = v; }} />
          </section>
        {/if}
      </div>

      <!-- ⑦ 优先级：后面的压过前面的 -->
      <p class="dp-prio" aria-label={t('优先级：图谱低于档位自定义，档位自定义低于口述备注')}>
        <span class="dp-prio-i">{t('图谱')}</span>
        <svg viewBox="0 0 22 8" aria-hidden="true"><path d="M1 4h19M16.5 1l3.5 3-3.5 3" /></svg>
        <span class="dp-prio-i">{t('档位自定义')}</span>
        <svg viewBox="0 0 22 8" aria-hidden="true"><path d="M1 4h19M16.5 1l3.5 3-3.5 3" /></svg>
        <span class="dp-prio-i">{t('口述备注')}</span>
        <span class="dp-prio-n">{t('靠后的优先')}</span>
      </p>
    </div>

    <!-- ⑧ 保存条：当前这一套有未保存的改动时从底部升起 -->
    <div class="dp-save-gap" aria-hidden="true"></div>
    <div class="dp-save-anchor">
      <div class="dp-save" class:up={dirty} inert={!dirty} aria-hidden={dirty ? undefined : 'true'}>
        <span class="dp-save-tx">
          {#if saveErr}
            <span class="dp-save-err" role="alert">{saveErr}</span>
          {:else}
            <span class="dp-save-t">{t('「{name}」有未保存的改动', { name: shownName })}</span>
            {#if changedText}<span class="dp-save-s">{changedText}</span>{/if}
          {/if}
        </span>
        <button type="button" class="dp-btn ghost" disabled={saving} onclick={discard}>{t('放弃')}</button>
        <button type="button" class="dp-btn pri" class:busy={saving} disabled={saving} onclick={save}>
          {#if saving}<span class="dp-spin" aria-hidden="true"></span>{t('保存中…')}{:else}{t('保存')}{/if}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* —— 令牌：两套外壳各有一组（手机 / 网页 --i-*、桌面 --dsk-*），这里统一成 --dp-*。先取 --i-*：
        网页壳跑在桌面客户端里时两组都在，--dsk-* 那组是全局的珊瑚强调色，不是设置页的墨色 —— */
  .dp {
    --dp-bg: var(--i-bg, var(--dsk-bg));
    --dp-card: var(--i-card, var(--dsk-panel));
    --dp-raised: var(--i-card, var(--dsk-bg-raised));
    --dp-ink: var(--i-label, var(--dsk-ink));
    --dp-ink2: var(--i-label2, var(--dsk-ink-2));
    --dp-ink3: var(--i-label3, var(--dsk-ink-3));
    --dp-line: var(--i-sep, var(--dsk-line));
    --dp-line2: var(--i-label4, var(--dsk-line-strong));
    --dp-sunk: var(--i-fill4, var(--dsk-hover));
    --dp-press: var(--i-press, var(--dsk-active));
    --dp-accent: var(--i-accent, var(--dsk-accent));
    --dp-on: var(--i-on-accent, var(--dsk-accent-ink));
    --dp-ok: var(--i-ok, var(--dsk-ok));
    --dp-warn: var(--i-warn, var(--dsk-warn));
    --dp-red: var(--i-red, var(--dsk-crit));
    container: dp / inline-size;
    position: relative;
    color: var(--dp-ink);
    text-wrap: pretty;
    -webkit-font-smoothing: antialiased;
  }
  /* 尺寸跟外壳走：桌面 = 12 圆角卡、14 / 12 字、28 高控件；手机 = 18 圆角卡、16 / 13 字、36 高控件 */
  .dp.desk {
    --dp-sub: var(--dp-ink3);
    --dp-edge: inset 0 0 0 1px var(--dp-line);
    --dp-r: 12px; --dp-r-c: 8px; --dp-h: 28px; --dp-px: 14px;
    --dp-fs: var(--dsk-fs-body, 14px); --dp-fs-s: var(--dsk-fs-sm, 12px); --dp-fs-c: var(--dsk-fs-ui, 13px);
    --dp-save-b: 16px;
  }
  .dp.ios {
    --dp-sub: var(--dp-ink2);
    --dp-edge: inset 0 0 0 .5px var(--dp-line2);
    --dp-r: 18px; --dp-r-c: 11px; --dp-h: 36px; --dp-px: 16px;
    --dp-fs: 16px; --dp-fs-s: 13px; --dp-fs-c: 15px;
    --dp-save-b: calc(var(--sab, 0px) + 12px);
  }

  /* —— 分区 —— */
  .dp-sec { margin-bottom: 26px; }
  .dp-sec-bar { margin-bottom: 16px; }
  .dp-label { margin: 0; font: inherit; font-weight: 500; }
  .desk .dp-label { margin: 0 12px 8px; font-size: var(--dp-fs-s); line-height: 1.4; color: var(--dp-ink3); }
  .ios .dp-label { padding: 0 16px 8px; font-size: 13px; line-height: 18px; letter-spacing: .2px; color: var(--dp-ink2); }
  .dp-label-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
  .desk .dp-label-row { margin-bottom: 6px; }
  .ios .dp-label-row { padding-bottom: 6px; min-height: 32px; }
  .dp-label-t { flex: none; margin: 0; font: inherit; }
  .dp-label-side { flex: 1; min-width: 0; text-align: right; font-weight: 400; color: var(--dp-ink3); }
  .ios .dp-label-side { color: var(--dp-ink2); letter-spacing: 0; }
  .dp-basis { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .dp-basis-l { flex: none; font-weight: 400; }
  .dp-basis-seg { display: inline-flex; }
  .desk .dp-basis-seg { min-width: 204px; }
  .desk .dp-basis-seg :global(.seg) { flex: 1; }
  .ios .dp-basis-seg { width: 208px; }
  .ios .dp-basis-seg :global(.seg) { width: 100%; }
  @container dp (max-width: 419px) { .dp-basis-l { display: none; } }

  /* —— 卡：底色 + 一圈发丝线（画在最上层，行的按下底色不会盖住它） —— */
  .dp :global(.dp-card) { position: relative; isolation: isolate; background: var(--dp-card); border-radius: var(--dp-r); }
  .dp :global(.dp-card)::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: var(--dp-edge); pointer-events: none; z-index: 2; }

  /* —— 总开关 —— */
  .dp-master { display: flex; align-items: center; gap: 12px; padding: 0 var(--dp-px); }
  .desk .dp-master { min-height: 46px; }
  .ios .dp-master { min-height: 54px; }
  .dp-master-t { flex: 1; min-width: 0; font-size: var(--dp-fs); font-weight: 500; }
  .ios .dp-master-t { font-weight: 400; letter-spacing: -.1px; }
  .dp-state { position: relative; margin: 0; padding: 10px var(--dp-px) 11px; font-size: var(--dp-fs-s); line-height: 1.5; color: var(--dp-ink2); }
  .dp-state::before { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); top: 0; height: 1px; background: var(--dp-line); }

  /* —— dimensio：策略来源（跟随 Claude / 单独一套）一行 + 跟随时的说明与去处。行间同一条发丝线 —— */
  .dp-src { position: relative; display: flex; align-items: center; gap: 12px; padding: 0 var(--dp-px); }
  .desk .dp-src { min-height: 46px; }
  .ios .dp-src { min-height: 54px; }
  .dp-src::before { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); top: 0; height: 1px; background: var(--dp-line); }
  .dp-src-t { flex: 1; min-width: 0; font-size: var(--dp-fs); }
  .dp-src-seg { flex: none; display: inline-flex; }
  .desk .dp-src-seg { min-width: 268px; }
  .desk .dp-src-seg :global(.seg) { flex: 1; }
  /* 不写死宽度：两格按较长的那个选项撑开（写死 252 时中文选中态加粗就截成省略号，英文更长） */
  .ios .dp-src-seg { min-width: 252px; }
  .ios .dp-src-seg :global(.seg) { flex: 1; }
  /* 窄处：说明退到上一行、分段铺满 */
  @container dp (max-width: 479px) {
    .dp-src { flex-wrap: wrap; row-gap: 8px; padding-top: 10px; padding-bottom: 10px; }
    .dp-src-seg, .desk .dp-src-seg, .ios .dp-src-seg { flex: 1 0 100%; min-width: 0; width: auto; }
  }
  .dp-follow { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; }
  .dp-follow > span { flex: 1 1 240px; min-width: 0; }
  .dp-follow :global(.dp-follow-go) { margin: -4px -6px -4px auto; }

  /* 总开关关着：下面照常能看能改，整体降一档对比 */
  .dp-dim { transition: opacity var(--mo-base, 280ms) var(--ea-fade, ease); }
  .dp.off .dp-dim { opacity: .56; }

  /* —— 按钮（子组件共用）：文字钮 / 描边钮 / 实心钮 —— */
  .dp :global(.dp-btn) {
    flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--dp-h); padding: 0 12px;
    border: 0; border-radius: var(--dp-r-c); background: transparent; box-shadow: inset 0 0 0 1px var(--dp-line2);
    color: var(--dp-ink); font: inherit; font-size: var(--dp-fs-c); font-weight: 500; line-height: 1; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease),
      opacity var(--mo-micro, 140ms) var(--ea-fade, ease), transform var(--mo-tap, 90ms) var(--ea-std, ease);
  }
  .dp :global(.dp-btn.ghost) { box-shadow: none; color: var(--dp-ink2); }
  .dp :global(.dp-btn.pri) { box-shadow: none; background: var(--dp-accent); color: var(--dp-on); font-weight: 600; }
  .dp :global(.dp-btn.danger) { color: var(--dp-red); }
  .dp :global(.dp-btn:active:not(:disabled):not([aria-disabled="true"])) { transform: scale(.96); }
  .dp :global(.dp-btn:disabled), .dp :global(.dp-btn[aria-disabled="true"]) { opacity: .42; cursor: default; }
  .dp :global(.dp-btn.pri.busy:disabled) { opacity: .72; }
  .dp :global(.dp-btn:focus-visible) { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
  .dp :global(.dp-btn.pri:focus-visible) { box-shadow: 0 0 0 2px var(--dp-card), 0 0 0 4px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
  @media (hover: hover) {
    .dp :global(.dp-btn:hover:not(:disabled):not([aria-disabled="true"]):not(.pri)) { background: var(--dp-sunk); color: var(--dp-ink); }
    .dp :global(.dp-btn.pri:hover:not(:disabled)) { opacity: .88; }
    .dp :global(.dp-btn.danger:hover:not(:disabled):not([aria-disabled="true"])) { color: var(--dp-red); }
  }
  .dp :global(.dp-spin) { flex: none; width: 13px; height: 13px; border-radius: 50%; border: 1.6px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor; animation: dp-rot .8s linear infinite; }
  @keyframes dp-rot { to { transform: rotate(360deg); } }

  /* —— 优先级示意：三枚线框字 + 两个细箭头 —— */
  .dp-prio { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin: -6px 0 0; font-size: var(--dp-fs-s); line-height: 1; color: var(--dp-ink3); }
  .desk .dp-prio { padding: 0 12px; }
  .ios .dp-prio { padding: 0 16px; color: var(--dp-ink2); }
  .dp-prio-i { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--dp-line2); white-space: nowrap; }
  .dp-prio svg { flex: none; width: 22px; height: 8px; fill: none; stroke: currentColor; stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; }
  .dp-prio-n { margin-left: 4px; white-space: nowrap; }

  /* —— 保存条：贴着滚动区底边的浮条。锚点零高度、sticky，不占版面；有改动时锚点前面垫出一截空白
        （sticky 出不了正文的范围：滚到底时浮条就停在这截空白上，不压着最后一行） —— */
  .dp-save-gap { height: 0; transition: height var(--mo-base, 280ms) var(--ea-std, ease); }
  .dp.dirty .dp-save-gap { height: 64px; }
  .dp.ios.dirty .dp-save-gap { height: 72px; }
  .dp-save-anchor { position: sticky; bottom: var(--dp-save-b); z-index: 5; height: 0; display: flex; justify-content: center; align-items: flex-end; pointer-events: none; }
  .dp-save {
    pointer-events: auto; display: flex; align-items: center; gap: 8px; box-sizing: border-box; width: min(560px, 100%); min-height: 52px; padding: 8px 10px 8px 16px;
    border-radius: 16px; background: var(--dp-raised);
    box-shadow: inset 0 0 0 1px var(--dp-line2), 0 12px 32px rgba(0, 0, 0, .16), 0 2px 6px rgba(0, 0, 0, .08);
    transform: translateY(calc(100% + 32px)); opacity: 0; visibility: hidden;
    transition: transform var(--mo-base, 280ms) var(--ea-accel, ease-in), opacity var(--mo-quick, 200ms) var(--ea-fade, ease), visibility 0s linear var(--mo-base, 280ms);
  }
  .dp-save.up { transform: none; opacity: 1; visibility: visible;
    transition: transform var(--mo-base, 280ms) var(--ea-decel, ease-out), opacity var(--mo-quick, 200ms) var(--ea-fade, ease), visibility 0s; }
  .ios .dp-save { min-height: 60px; padding: 10px 10px 10px 18px; border-radius: 20px; }
  .dp-save-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .dp-save-t { font-size: var(--dp-fs-c); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dp-save-s { font-size: var(--dp-fs-s); color: var(--dp-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dp-save-err { font-size: var(--dp-fs-c); line-height: 1.4; color: var(--dp-red); overflow-wrap: anywhere; }
  .dp-save :global(.dp-btn.pri) { min-width: 72px; }

  /* —— 加载骨架 / 出错 —— */
  .dp-skel { display: flex; flex-direction: column; gap: 22px; }
  .dp-sk { border-radius: var(--dp-r); background: var(--dp-card); box-shadow: var(--dp-edge); animation: dp-breathe 1.4s var(--ea-fade, ease) infinite alternate; }
  .dp-sk-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .dp-sk-chips { width: 62%; height: 34px; border-radius: 999px; }
  @keyframes dp-breathe { from { opacity: 1; } to { opacity: .55; } }
  @container dp (max-width: 559px) { .dp-sk-row { grid-template-columns: 1fr; } .dp-sk-row .dp-sk:nth-child(n + 2) { display: none; } }
  .dp-msg { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 10px 8px var(--dp-px); font-size: var(--dp-fs-c); color: var(--dp-ink2); }
  .dp-msg-tx { flex: 1; min-width: 0; overflow-wrap: anywhere; }

  @media (prefers-reduced-motion: reduce) {
    .dp-dim, .dp-save, .dp-save.up, .dp-save-gap, .dp :global(.dp-btn) { transition: none; }
    .dp-sk, .dp :global(.dp-spin) { animation: none; }
    .dp :global(.dp-btn:active:not(:disabled)) { transform: none; }
  }
</style>
