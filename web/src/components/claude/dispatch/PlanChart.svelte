<script>
  // 子 agent 调用策略 · 性价比图。和「订阅 plan 性价比图」是同一张图：横轴每任务成本（元，对数），纵轴智力指数，
  // 点按厂商着色（海外圆、国内菱形、第三方平台方），订阅 / plan 价实心、API 价空心，性价比前沿画成阶梯。
  // 多出来的是四条判定线：每档一条横贯全宽的线，左端的小标签既是读数也是手柄——拖它，这一档「够格」的门槛就跟着走。
  //
  // 读图的方法就一句：每档选「线以上最便宜的那个点」，而这个点一定在阶梯上——所以线和阶梯的交点右边那一级台阶就是落点。
  //
  // props
  //   candidates  已配置、评上分的候选点 [{ model, label, effort, ii, cost, basis:'sub'|'plan'|'api', provider, creator, vkey?, est? }]
  //               成本不是正数的（图谱里没有它的价格）在对数轴上没有位置：贴着图版左缘画成虚线点，提示里说明
  //   tiers       四档 [{ key, floor, floorDefault, pick:{ model, effort, ii?, cost?, label?, basis?, est? }, source:'chart'|'override', short }]
  //               pick 的 model + effort 在候选里找得到就认那个点；找不到（档位自定义落在没评分的推理强度上，服务端借了
  //               相近一档的分数与成本）时靠 pick 自己带的 ii / cost 落位：同模型里正好有这个分数与成本的点 → 环套在它上面，
  //               没有 → 在那个位置补一个虚点；连 ii 都没带 → 这一档不画环（不报错）
  //   allPoints   全图点表 { points:[[vkey, plan, slug, family, effort, score, cost, src], …], vendors }；null = 没有
  //   showAll     把全图的点垫在后面（小、淡、不可点，只有提示）
  //   editable    能不能拖线 / 键盘调线
  //   onfloor(key, value, { final })   拖动中连续回调（final:false），松手一次 final:true；键盘每步一次 final:true
  //   onreset(key)                     双击一条线（或它的手柄）、手柄上按 Delete = 这条恢复默认
  //   onpick(candidate, { x, y })      点一个候选点（x, y = 这个点在视口里的位置，给调用方摆菜单）；触屏是「先点出提示，再点一下」
  //   emptyHint   空态第二行的引导（不给用默认那句）
  //   width       给定就不自己量宽度（测试 / 截图用）
  //
  // 受控：线画在哪只认 tiers 里的 floor，拖动中才用自己手上的值；落点的环同理——拖动中先按同一条规则在本地算，
  // 松手后等调用方的预览回来再交还（两边规则相同，交接看不出来）。
  //
  // 手势：只有手柄带 touch-action:none；手指一按上手柄就冒泡一个 dp-drag 事件（detail:true，松手 false），
  // 手机外壳据此停掉左缘右滑返回。鼠标另外可以直接抓线身。
  //
  // 拖线时哪些该动：拖动的每一步，调用方都会换一份新的 tiers（还会隔一阵换一份内容相同的 candidates）。跟着动的只有
  // 判定线自己（线、手柄、读数）、线以下点的变淡、以及落点换了之后的环与档名签。坐标轴、全图的点（两千多个）、候选点的坐标、
  // 前沿、标注避让都不跟——靠两件事：一是中间那几层派生量（候选点、虚点、落点、视野、图版）内容没变就交回同一个对象
  //（keeper / 拆成数），下游认的是身份；二是标注避让在拖动中不追着线跑，落点换了才重排。改这里的依赖时留意别把这条链接回去。
  //
  // 颜色：四档读 --dp-t-top / hard / normal / light（子页根给；没给就用这里兜底的同一份色值），厂商点色是原图的八个槽位。
  // 其余只用外壳的墨色与卡片底色，深浅跟 ui.theme。
  import { onDestroy, tick, untrack } from 'svelte';
  import { ui } from '../../../lib/state.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';
  import { DUR, SPRING, spring, bezier, reduced } from '../../../lib/motion.js';
  import { haptic } from '../../../lib/dragdrop.svelte.js';
  import { TIER_META, modelName, effortName } from '../../../lib/dispatchPolicy.svelte.js';
  import {
    isNarrow, chartHeight, plotBox, extentOf, domainFrom, sameDomain, lerpDomain, xOf, yOf, scoreAt, scorePerPx,
    yTicks, xTicks, thinTicks, fmtTick, fmtCost, fmtScore, clampFloor, snapFloor, stepFloor,
    pickForFloor, locatePicks, frontier, stairPath, nearestIndex, spreadLabels, placeLabels, placeTip,
    vendorKeyOf, vendorSlot, shapeKind, shapePath,
  } from '../../../lib/dispatchChartMath.js';

  let {
    candidates = [], tiers = [], allPoints = null, showAll = false, editable = false,
    onfloor = null, onreset = null, onpick = null, emptyHint = '', width = 0,
  } = $props();
  const uid = $props.id();

  // —— 尺寸 ——
  let root = $state(), svgEl = $state();
  let measured = $state(0);
  $effect(() => {
    if (!root) return;
    const ro = new ResizeObserver(() => { measured = root.clientWidth; });
    ro.observe(root);
    measured = root.clientWidth;
    return () => ro.disconnect();
  });
  const W = $derived(width || measured);
  const narrow = $derived(isNarrow(W));
  const H = $derived(chartHeight(W));
  const R = $derived(narrow ? 5 : 6);
  const dark = $derived(ui.theme !== 'light');

  // —— 量字宽（canvas，和页面同一套字体；字体加载完再量一遍）——
  let fontTick = $state(0);
  let ctx2d = null, fam = '', famAt = -1;
  const widths = new Map();
  $effect(() => { document.fonts?.ready?.then(() => { widths.clear(); fontTick++; }); });
  function textW(str, size, weight) {
    const round = fontTick;
    const s = String(str);
    if (typeof document === 'undefined') { let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.56; return w; }
    // 字体族一轮只取一次（拖线时每一帧都要量）；挂上之后 fonts.ready 那一下会再取，那时读的是自己根上的字体
    if (famAt !== round || !fam) { fam = getComputedStyle(root || document.body).fontFamily || 'sans-serif'; famAt = round; }
    const id = weight + '|' + size + '|' + fam + '|' + s;
    let w = widths.get(id);
    if (w == null) {
      if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d');
      ctx2d.font = `${weight} ${size}px ${fam}`;
      w = ctx2d.measureText(s).width * 1.03;
      widths.set(id, w);
    }
    return w;
  }

  // —— 数据 ——
  const vmeta = $derived.by(() => {
    const m = new Map();
    for (const v of (allPoints && !Array.isArray(allPoints) && allPoints.vendors) || []) if (v && v.key) m.set(v.key, v);
    return m;
  });
  const rows = $derived(showAll && allPoints ? (Array.isArray(allPoints) ? allPoints : allPoints.points) || [] : []);
  const pickId = (model, effort) => String(model || '') + '\n' + String(effort || '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const numOf = (v) => (v == null || v === '' ? NaN : Number(v));
  // 记一份结果：输入还是那几个对象 → 直接交回上次的；输入换了就重算，但算出来的内容（签名）没变仍交回上次的对象。
  // 下游那些重的派生量（点的坐标、前沿、标注避让）认的是身份——拖线途中调用方每一步都换一份新数组（内容多半没变），
  // 不能让整张图跟着白算。先比输入的身份，是因为 Svelte 的派生量只要有过一次「依赖变了、自己的值没变」，
  // 往后每次被问到都会重跑一遍（它拿依赖的版本号和自己的比，自己的值没变版本号就不涨）：重跑必须便宜。
  // 前提：输入是整份换的、不就地改（candidates 是服务端应答里的数组，一向如此）。
  function keeper(make, sigOf) {
    let args = null, last, sig;
    return (...now) => {
      if (args && now.every((v, i) => v === args[i])) return last;
      args = now;
      const next = make(...now), s = sigOf(next);
      if (last === undefined || s !== sig) { last = next; sig = s; }
      return last;
    };
  }
  // 一个点：有分数才有位置。成本不是正数 = 图谱里没有它的价格（free）：对数轴上没处放，贴着图版左缘画
  function entry(c, i, ghost, meta) {
    const ii = numOf(c && c.ii);
    if (!c || !Number.isFinite(ii)) return null;
    const cost = numOf(c.cost), free = !(cost > 0) || !Number.isFinite(cost);
    const vk = vendorKeyOf(c);
    return {
      c, id: (ghost ? 'g' : 'c') + i, model: String(c.model || ''), effort: String(c.effort || ''), ii, cost: free ? 0 : cost, free,
      vk, slot: vendorSlot(vk), kind: shapeKind(vk, meta.get(vk)), hollow: c.basis === 'api', ghost,
    };
  }
  const NONE = [];
  const entrySig = (list) => list.map((p) => p.id + '\t' + p.kind + '\t' + JSON.stringify(p.c)).join('\n');
  // 候选。拖线途中调用方的实时预览每回来一次，就换一份内容相同的新数组
  const keepCands = keeper((list, meta) => list.map((c, i) => entry(c, i, false, meta)).filter(Boolean), entrySig);
  const cands = $derived(keepCands(candidates || NONE, vmeta));
  const byPick = $derived(new Map(cands.map((p, k) => [pickId(p.model, p.effort), k])));

  // —— 四档 ——
  const lines = $derived.by(() => {
    const out = [];
    for (const m of TIER_META) {
      const tier = (tiers || []).find((x) => x && x.key === m.key);
      if (!tier) continue;
      const def = num(tier.floorDefault), base = num(tier.floor) ?? def;
      if (base != null) out.push({ key: m.key, meta: m, tier, def, base });
    }
    return out;
  });
  let drag = $state(null);        // { key, id, touch, grab, y0, moved, from, val, k }
  const dragging = $derived(!!drag && drag.moved);
  const floors = $derived.by(() => {
    const o = {};
    for (const l of lines) o[l.key] = drag && drag.key === l.key ? drag.val : l.base;
    return o;
  });
  // 各档的落点各在哪个点上（规则见 locatePicks）。档位自定义落在候选里没有的格子上、又借不到现成的点时补一个虚点，环才有地方套
  const pickOf = (p) => (p ? { ...p, model: String(p.model || ''), effort: String(p.effort || ''), ii: numOf(p.ii), cost: numOf(p.cost) } : null);
  const located = $derived(locatePicks(cands, lines.map((l) => pickOf(l.tier.pick))));
  const keepGhosts = keeper((list, meta) => list.map((p, i) => entry({ ...p, est: true }, i, true, meta)), entrySig);
  const ghosts = $derived(keepGhosts(located.ghosts, vmeta));

  // —— 视野：换数据 / 开关全图时坐标轴滑过去 ——
  const candExtent = $derived(extentOf([...cands, ...ghosts].map((p) => ({ cost: p.cost, score: p.ii })), { free: true }));
  const rowExtent = $derived(extentOf(rows.map((r) => ({ cost: Number(r[6]), score: Number(r[5]) }))));
  // 判定线最高到哪，纵轴就得装到哪（线是绝对分，可能比眼下这批点都高）。拖动中不跟：线只在现有的纵轴里拖，
  // 松手后纵轴要是该收了再滑过去——拖到一半坐标轴自己缩放，线就不跟手了
  let reachKept = -Infinity;
  const reach = $derived.by(() => {
    const top = Math.max(-Infinity, ...lines.map((l) => l.base));
    if (!drag) reachKept = top;
    return reachKept;
  });
  let targetKept = null;
  const target = $derived.by(() => {
    const next = domainFrom([candExtent, rowExtent], reach);
    if (!sameDomain(targetKept, next)) targetKept = next;
    return targetKept;
  });
  let dom = $state.raw(null);
  let tweening = $state(false);
  $effect(() => {
    const to = target;
    let raf = 0;
    untrack(() => {
      const from = dom;
      // 视野没变：连对象都不换。换了的话 view 的身份跟着变，坐标轴、全图的点、前沿、所有点的坐标全得重算一遍
      if (from && to && sameDomain(from, to)) { tweening = false; return; }
      if (!to || !from || reduced()) { dom = to; tweening = false; return; }
      const ease = bezier(0.2, 0, 0, 1), t0 = performance.now();
      tweening = true;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / DUR.base);
        dom = k < 1 ? lerpDomain(from, to, ease(k)) : to;
        if (k < 1) raf = requestAnimationFrame(step); else tweening = false;
      };
      raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  });
  const view = $derived(dom || target);

  // —— 版面 ——
  const PILL_H = 22, HIT_H = 30, NECK = 9, TAG_H = 16;
  // 手柄的宽度拆成几个数分开算：拖动中 lines / floors 每一步都是新的，但这几个数不变，图版（box）也就不换——
  // box 一换，坐标轴、全图的点、前沿、所有点的坐标都得重算
  const nameW = $derived(Math.max(0, ...lines.map((l) => textW(narrow ? l.meta.short : l.meta.title, 11, 500))));
  const valW = $derived(textW(lines.some((l) => floors[l.key] >= 99.95) ? '100.0' : '88.8', 11.5, 600));
  const pillW = $derived(Math.ceil(7 + nameW + 9 + valW + 7));
  const gutter = $derived(lines.length ? pillW + NECK + 3 : 0);
  const box = $derived(plotBox(W, H, narrow, gutter));
  const X = (v) => xOf(v, view, box);
  const Y = (s) => yOf(s, view, box);
  const fx = (v) => +v.toFixed(2);

  const yt = $derived(view ? yTicks(view).map((s) => ({ s, y: Y(s) })) : []);
  const xt = $derived.by(() => {
    if (!view) return { major: [], minor: [] };
    const tk = xTicks(view), xs = tk.major.map(X), show = thinTicks(xs, narrow ? 34 : 40);
    return { major: tk.major.map((v, i) => ({ v, x: xs[i], label: show[i] })), minor: tk.minor.map(X) };
  });

  // —— 点 ——（没有价格的贴着图版左缘）
  const dots = $derived(view ? [...cands, ...ghosts].map((p) => ({ ...p, x: p.free ? box.l + R + 3 : X(p.cost), y: Y(p.ii) })) : []);
  const front = $derived(frontier(cands));               // cands 的下标，成本升序
  const frontSet = $derived(new Set(front));
  const stair = $derived.by(() => {
    if (!view || !front.length) return null;
    const path = stairPath(front.map((k) => [X(cands[k].cost), Y(cands[k].ii)]), box.l + box.w);
    const str = (pts) => pts.map(([x, y]) => fx(x) + ',' + fx(y)).join(' ');
    return { path, line: str(path), fill: str([[path[0][0], box.t + box.h], ...path, [box.l + box.w, box.t + box.h]]) };
  });
  // 全图：两千多个点按「颜色 × 实心 / 空心」拼成几十条 path（一个点一个节点的话坐标轴滑动那几帧会卡）
  const all = $derived.by(() => {
    if (!view || !rows.length) return { paths: [], pos: [] };
    const groups = new Map(), pos = [];
    for (const r of rows) {
      const cost = Number(r[6]), score = Number(r[5]);
      if (!(cost > 0) || !Number.isFinite(cost) || !Number.isFinite(score)) continue;
      const vk = r[0], slot = vendorSlot(vk), hollow = r[7] === 'api', id = slot + (hollow ? 'o' : 'f');
      let g = groups.get(id);
      if (!g) groups.set(id, g = { id, slot, hollow, d: '' });
      const x = X(cost), y = Y(score);
      g.d += shapePath(shapeKind(vk, vmeta.get(vk)), 3, x, y);
      pos.push({ x, y, r });
    }
    return { paths: [...groups.values()], pos };
  });

  // —— 落点 ——
  let hold = $state(null);        // 松手后、调用方的预览回来之前，先沿用本地算的落点：{ key, pick, short }
  let holdTimer = 0;
  $effect(() => {
    const h = hold;
    if (!h) return;
    const row = (tiers || []).find((x) => x && x.key === h.key);
    if (row && row.pick && pickId(row.pick.model, row.pick.effort) === h.pick) untrack(() => { hold = null; });
  });
  const pointName = (c) => {
    const name = c.label || modelName(c.model);
    return c.effort ? name + ' · ' + effortName(c.model, c.effort) : name;
  };
  // 每档落在哪个点（dots 的下标，−1 = 没处画）。拖线的每一步都会重算，但只要结果没变就还是同一个数组——
  // 环、档名签、标注避让、点的叠放次序都挂在它后面
  const keepPicks = keeper((list) => list, (list) => list.map((p) => [p.key, p.k, p.short ? 1 : 0, p.override ? 1 : 0, p.name].join('\t')).join('\n'));
  const picks = $derived(keepPicks(lines.map((l, i) => {
    const chart = l.tier.source !== 'override', spot = located.spots[i];
    let k = spot.at >= 0 ? spot.at : spot.ghost >= 0 ? cands.length + spot.ghost : -1, short = !!l.tier.short, lent = spot.lent;
    if (chart && drag && drag.key === l.key && drag.moved) {
      const hit = pickForFloor(cands, drag.val);
      if (hit) { k = hit.index; short = hit.short; lent = false; }
    } else if (chart && hold && hold.key === l.key && byPick.has(hold.pick)) { k = byPick.get(hold.pick); short = hold.short; lent = false; }
    // name：环是借别的点套着的（这一档指定的那一格没有评分）时，这一档真正指定的是什么——标注和提示里要写出来
    return { key: l.key, meta: l.meta, k, short, override: !chart, name: lent ? pointName(pickOf(l.tier.pick)) : '' };
  })));
  // 同一个点被几档选中：环由里到外叠、档名签并排
  const marks = $derived.by(() => {
    const groups = new Map();
    for (const p of picks) {
      if (p.k < 0 || !dots[p.k]) continue;
      let g = groups.get(p.k);
      if (!g) groups.set(p.k, g = { k: p.k, tiers: [] });
      g.tiers.push({ key: p.key, meta: p.meta, override: p.override, name: p.name });
    }
    return [...groups.values()];
  });
  const ringR = (n) => R + 4 + n * 3.5;
  const rings = $derived(marks.flatMap((g) => g.tiers.map((x, n) => ({ key: x.key, color: x.meta.color, override: x.override, x: dots[g.k].x, y: dots[g.k].y, r: ringR(n) }))));
  const pickedSet = $derived(new Set(marks.map((g) => g.k)));

  // —— 判定线与手柄的几何 ——
  const lineGeo = $derived.by(() => {
    if (!view || !lines.length) return [];
    const top = box.t, bot = box.t + box.h;
    const ys = lines.map((l) => Math.min(bot, Math.max(top, Y(floors[l.key]))));
    const py = spreadLabels(ys, PILL_H + 2, top, bot, drag ? lines.findIndex((l) => l.key === drag.key) : -1);
    return lines.map((l, i) => ({
      ...l, floor: floors[l.key], y: ys[i], py: py[i], short: picks[i].short,
      adjusted: l.def != null && Math.abs(floors[l.key] - l.def) > 0.049,
    }));
  });
  // 画面上此刻的位置：弹簧追着目标走（键盘步进、恢复默认、换策略、被旁边的手柄挤开）；正在拖的那条、以及版面本身在变的时候直接到位
  let shown = $state({});         // key → { y, py }
  const chase = new Map();        // 'top.y' → { to, sp, v }
  let geoSig = '';
  function settleTo(key, field, to, direct) {
    const id = key + '.' + field;
    let c = chase.get(id);
    if (!c) chase.set(id, c = { to: NaN, sp: null, v: 0 });
    const cur = shown[key] ? shown[key][field] : undefined;
    if (direct || cur == null) {
      c.sp?.cancel(); c.sp = null; c.v = 0; c.to = to;
      if (!shown[key]) shown[key] = { y: to, py: to };
      shown[key][field] = to;
      return;
    }
    if (c.to === to && (c.sp || Math.abs(cur - to) < 0.01)) return;
    c.sp?.cancel();
    c.to = to;
    c.sp = spring({
      from: cur, to, velocity: c.v, ...SPRING.crisp, restDist: 0.2, restVel: 4,
      onUpdate: (x, v) => { c.v = v; if (shown[key]) shown[key][field] = x; },
      onDone: () => { c.v = 0; c.sp = null; },
    });
    if (!c.sp.alive) c.sp = null;   // 减少动态效果：spring 当场落定
  }
  $effect(() => {
    const geo = lineGeo, live = drag ? drag.key : '', sig = [W, H, box.l, view && view.Y0, view && view.Y1].join();
    const moving = tweening;
    untrack(() => {
      const direct = moving || sig !== geoSig;
      geoSig = sig;
      const keep = new Set(geo.map((l) => l.key));
      for (const key of Object.keys(shown)) {
        if (keep.has(key)) continue;
        delete shown[key];
        for (const f of ['y', 'py']) { chase.get(key + '.' + f)?.sp?.cancel(); chase.delete(key + '.' + f); }
      }
      for (const l of geo) { settleTo(l.key, 'y', l.y, direct || l.key === live); settleTo(l.key, 'py', l.py, direct || l.key === live); }
    });
  });
  const at = (l) => shown[l.key] || l;

  // —— 标注：落点的档名签（必放）+ 其余前沿点的名字（放得下才放，窄屏不放）——
  // 窄屏上档名签只剩一个字、旁边没有模型名：签要紧贴自己的点（TAG_GAP），和别的落点、别的签隔开（TAG_CLEAR），
  // 不然两个签挨在两个点中间，分不清各指哪个；实在挤不下的会被排到远处并拉一根引线
  const TAG_GAP = 2, TAG_CLEAR = 6;
  const layout = $derived.by(() => {
    if (!view || !dots.length) return { caps: [], labels: [] };
    const bounds = { x0: box.l + 2, x1: box.l + box.w - 2, y0: box.t, y1: box.t + box.h - 2 };
    const capId = (g) => g.tiers.map((tg) => tg.key).join('+');
    const outer = new Map(marks.map((g) => [g.k, ringR(g.tiers.length - 1) + 1]));
    const owner = new Map(narrow ? marks.map((g) => [g.k, capId(g)]) : []);
    const obstacles = dots.map((d, k) => {
      const r = (outer.get(k) || R) + 1, o = { x0: d.x - r, x1: d.x + r, y0: d.y - r, y1: d.y + r };
      return owner.has(k) ? { ...o, of: owner.get(k), pad: TAG_CLEAR } : o;
    });
    // 阶梯也算障碍：沿折线每 6px 一个小方块，标注别压线
    if (stair) for (let i = 0; i + 1 < stair.path.length; i++) {
      const [ax, ay] = stair.path[i], [bx, by] = stair.path[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 6));
      for (let j = 0; j <= n; j++) { const x = ax + ((bx - ax) * j) / n, y = ay + ((by - ay) * j) / n; obstacles.push({ x0: x - 2, x1: x + 2, y0: y - 2, y1: y + 2 }); }
    }
    // 判定线同理：落点就贴在自己那条线的上方，签不躲的话字正好压在线上。
    // 拖动中不追着线重排——那样每一步都要把所有点和阶梯再避让一遍，签也会被线撵着来回跳；落点换了才重排（用当时的线位），
    // 松手后再按最终位置排一次
    const bars = dragging ? untrack(() => lineGeo) : lineGeo;
    for (const l of bars) obstacles.push({ x0: box.l, x1: box.l + box.w, y0: l.y - 2.5, y1: l.y + 2.5 });
    const caps = marks.map((g) => {
      const d = dots[g.k];
      let x = 0;
      const tags = g.tiers.map((tg) => {
        const name = narrow ? tg.meta.short : tg.meta.title, w = Math.ceil(textW(name, 10.5, 600)) + 10;
        const out = { key: tg.key, name, color: tg.meta.color, x, w };
        x += w + 3;
        return out;
      });
      // 窄屏只留档名签（模型名看提示框和上面的落点表），宽屏签后面跟模型 · 推理强度——
      // 环是借这个点套着的那几档，写它们真正指定的那一格（和这个点只差推理强度）
      const lent = g.tiers[0].name && g.tiers.every((tg) => tg.name === g.tiers[0].name) ? g.tiers[0].name : '';
      const text = narrow ? '' : lent || pointName(d.c);
      return { id: capId(g), k: g.k, x: d.x, y: d.y, r: outer.get(g.k), tags, text, textX: x + 2, w: text ? x + 2 + Math.ceil(textW(text, 11, 500)) : x - 3, h: TAG_H, must: true };
    });
    const names = narrow ? [] : front.filter((k) => !pickedSet.has(k)).sort((a, b) => cands[b].ii - cands[a].ii).map((k) => {
      const text = pointName(dots[k].c);
      return { id: dots[k].id, k, x: dots[k].x, y: dots[k].y, r: R + 1, text, w: Math.ceil(textW(text, 11, 500)), h: 13 };
    });
    const placed = placeLabels([...caps, ...names], narrow ? { bounds, obstacles, gap: TAG_GAP, clear: TAG_CLEAR } : { bounds, obstacles });
    // 签被挤到远处时拉一根引线回它的点（坐标相对签自己：签滑动时线跟着走）
    const lead = (c, q) => {
      if (!q.far) return null;
      const tx = Math.min(Math.max(c.x, q.x), q.x + c.w), ty = Math.min(Math.max(c.y, q.y), q.y + c.h), len = Math.hypot(tx - c.x, ty - c.y) || 1;
      return { x1: c.x + ((tx - c.x) / len) * c.r - q.x, y1: c.y + ((ty - c.y) / len) * c.r - q.y, x2: tx - q.x, y2: ty - q.y };
    };
    return {
      caps: caps.map((c, i) => ({ ...c, px: placed[i].x, py: placed[i].y, lead: lead(c, placed[i]) })),
      labels: names.map((n, i) => ({ ...n, at: placed[caps.length + i] })).filter((n) => n.at),
    };
  });
  // 画的先后：普通点 → 前沿点 → 落点（越要紧越靠上）
  const rank = (k) => (pickedSet.has(k) ? 2 : frontSet.has(k) ? 1 : 0);
  const order = $derived(dots.map((_, k) => k).sort((a, b) => rank(a) - rank(b)));
  const kbOrder = $derived(dots.map((_, k) => k).sort((a, b) => dots[a].x - dots[b].x || dots[b].y - dots[a].y));

  // —— 悬浮 / 点按提示 ——
  let hover = $state(null);       // { k } 候选点 | { a } 全图的点
  let kb = $state(false);         // 提示是键盘焦点带出来的（画焦点环）
  let armed = $state(-1);         // 触屏：已经点出提示的那个点，再点它一下才算「选它」
  let lastType = $state('');      // 最近一次按下是鼠标还是手指
  let swallowUntil = 0;
  const BASIS = { sub: () => t('订阅均值'), plan: () => t('plan 均值'), api: () => t('API 价') };
  const basisName = (b) => (BASIS[b] ? BASIS[b]() : '');
  const rowEffort = (e) => (e === '非推理' ? 'off' : e === '默认' || !e ? '' : String(e));   // i18n-ignore 图谱数据里的原值
  const tip = $derived.by(() => {
    if (drag || !view || !hover) return null;
    if (hover.k != null) {
      const d = dots[hover.k];
      if (!d) return null;
      const mine = marks.find((g) => g.k === hover.k), on = mine ? mine.tiers : [];
      return {
        x: d.x, y: d.y, slot: d.slot, kind: d.kind, hollow: d.hollow, free: d.free, title: pointName(d.c), sub: d.c.provider ? tr(d.c.provider) : '',
        ii: d.ii, cost: d.cost, basis: basisName(d.c.basis), est: !!d.c.est,
        tiers: on.filter((x) => !x.name).map((x) => x.meta.title),
        lent: on.filter((x) => x.name).map((x) => ({ tier: x.meta.title, name: x.name })),   // 借这个点套环的那几档
        hint: !!onpick && !d.ghost && armed === hover.k && lastType === 'touch',
      };
    }
    const p = all.pos[hover.a];
    if (!p) return null;
    const [vk, plan, , family, effort, score, cost, src] = p.r;
    const eff = rowEffort(effort), vendor = vmeta.get(vk);
    return {
      x: p.x, y: p.y, slot: vendorSlot(vk), kind: shapeKind(vk, vendor), hollow: src === 'api', free: false,
      title: eff ? family + ' · ' + effortName('', eff) : String(family || ''),
      sub: [vendor && vendor.name ? tr(vendor.name) : '', src === 'api' ? '' : tr(String(plan || ''))].filter(Boolean).join(' · '),
      ii: Number(score), cost: Number(cost), basis: src === 'api' ? t('API 价') : t('这个 plan 的价'), est: false, tiers: [], lent: [], hint: false,
    };
  });
  let tipEl = $state();
  let tipXY = $state.raw(null);
  $effect(() => {
    const cur = tip, el = tipEl, w = W, h = H;
    tipXY = cur && el ? placeTip(cur.x, cur.y, el.offsetWidth, el.offsetHeight, w, h) : null;
  });
  // 触屏：点图外面收起提示
  $effect(() => {
    if (!hover) return;
    const off = (e) => { if (root && !root.contains(e.target)) { hover = null; armed = -1; } };
    document.addEventListener('pointerdown', off, true);
    return () => document.removeEventListener('pointerdown', off, true);
  });

  function local(e) {
    const r = svgEl.getBoundingClientRect();
    return { mx: (e.clientX - r.left) * (r.width ? W / r.width : 1), my: (e.clientY - r.top) * (r.height ? H / r.height : 1) };
  }
  function findAt(mx, my, radius) {
    const k = nearestIndex(dots, mx, my, radius);
    if (k >= 0) return { k };
    const a = all.pos.length ? nearestIndex(all.pos, mx, my, Math.min(radius, 12)) : -1;
    return a >= 0 ? { a } : null;
  }
  function onMove(e) {
    if (e.pointerType === 'touch' || drag) return;
    const { mx, my } = local(e);
    kb = false;
    hover = findAt(mx, my, 24);
  }
  function onLeave(e) { if (e.pointerType !== 'touch' && !drag && !kb) hover = null; }
  function choose(k) {
    const d = dots[k];
    if (!d || d.ghost || !onpick) return;
    const r = svgEl.getBoundingClientRect();
    hover = null; armed = -1;
    onpick(d.c, { x: r.left + d.x * (r.width && W ? r.width / W : 1), y: r.top + d.y * (r.height && H ? r.height / H : 1) });
  }
  function onClick(e) {
    if (performance.now() < swallowUntil) return;
    // 点在手柄上不算点了它旁边的点；鼠标点在线身上同理（那是在抓线）
    const on = e.target && e.target.closest ? e.target : null;
    if (on && on.closest('.th')) return;
    const { mx, my } = local(e);
    if ((e.pointerType || lastType) === 'touch') {
      // 触屏没有悬浮：第一下点出提示，再点同一个点才是「选它」
      const hit = findAt(mx, my, 28);
      if (hit && hit.k != null && armed === hit.k && onpick && !dots[hit.k].ghost) { choose(hit.k); return; }
      kb = false;
      hover = hit;
      armed = hit && hit.k != null ? hit.k : -1;
      return;
    }
    if (on && on.closest('.tl-hit')) return;
    const k = nearestIndex(dots, mx, my, R + 5);
    if (k >= 0) choose(k);
  }
  // 键盘：候选点是一组 roving tabindex（Tab 进来只停一次，方向键按成本从低到高走，回车 = 选它）
  let tabK = $state(-1);
  const tabAt = $derived(dots[tabK] ? tabK : kbOrder[0] ?? -1);
  function onDotKey(e, k) {
    const i = kbOrder.indexOf(k);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? i - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? kbOrder.length - 1 : -2;
    if (to !== -2) {
      e.preventDefault();
      const next = kbOrder[Math.min(kbOrder.length - 1, Math.max(0, to))];
      tabK = next;
      tick().then(() => svgEl?.querySelector(`[data-k="${next}"]`)?.focus());
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(k); }
    else if (e.key === 'Escape' && hover) { e.stopPropagation(); hover = null; kb = false; }
  }
  const dotFocus = (k) => { tabK = k; kb = true; hover = { k }; };
  const dotBlur = (k) => { if (kb && hover && hover.k === k) { hover = null; kb = false; } };
  const dotLabel = (d) => (d.free
    ? t('{name}，智力分 {ii}，没有价格数据', { name: pointName(d.c), ii: fmtScore(d.ii) })
    : t('{name}，智力分 {ii}，每任务成本 {cost}，{basis}', { name: pointName(d.c), ii: fmtScore(d.ii), cost: fmtCost(d.cost), basis: basisName(d.c.basis) }));

  // —— 拖判定线 ——
  let hoverLine = $state(''), focusLine = $state('');
  const active = $derived(drag ? drag.key : focusLine || hoverLine);
  let lastTap = null;             // { key, at }：两下连点 = 恢复默认
  function signalDrag(on) {
    const ev = new CustomEvent('dp-drag', { detail: on, bubbles: true, composed: true });
    // 半路被卸载时根已经不在文档里：发到 document 上，挂在 window / document 的监听照样收得到
    (root && root.isConnected ? root : document).dispatchEvent(ev);
  }
  const yLocal = (e) => { const r = svgEl.getBoundingClientRect(); return (e.clientY - r.top) * (r.height ? H / r.height : 1); };
  function startDrag(e, l, via) {
    if (!editable || drag || !view) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (via === 'line' && e.pointerType === 'touch') return;   // 触屏只认手柄：线身上的滑动留给页面滚动
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    const y = yLocal(e);
    clearTimeout(holdTimer); hold = null;
    hover = null; kb = false; armed = -1;
    // grab 按线的真实位置算（不夹进图版）：线要是高出纵轴、只能夹在图顶上画，起手那一下也不会把值拽到纵轴上限——
    // 手指往下走多少、值就从原值往下走多少；from 记着原值，夹取的上限不低于它（见 floorBounds）
    drag = { key: l.key, id: e.pointerId, touch: e.pointerType === 'touch', grab: y - Y(floors[l.key]), y0: y, moved: false, from: floors[l.key], val: floors[l.key], k: -1 };
    signalDrag(true);
  }
  function moveDrag(e) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    const y = yLocal(e);
    if (!d.moved) {
      if (Math.abs(y - d.y0) < (d.touch ? 4 : 2)) return;
      d.moved = true;
    }
    const l = lines.find((x) => x.key === d.key);
    if (!l) return;
    // 贴近默认线 4px 以内就吸上去（想拖回默认时落得准），再夹进相邻两档之间
    let v = snapFloor(scoreAt(y - d.grab, view, box), [l.def], 4 * scorePerPx(view, box));
    v = clampFloor(d.key, v, floors, { min: view.Y0, max: view.Y1, from: d.from });
    if (v === d.val) return;
    if (d.touch) {
      // 手上的一格：线压过一个点（落点换了）或吸到默认线时轻震一下
      const hit = l.tier.source !== 'override' ? pickForFloor(cands, v) : null, k = hit ? hit.index : -1;
      if ((d.k >= 0 && k !== d.k) || (v === l.def && d.val !== l.def)) haptic('tick');
      d.k = k;
    }
    d.val = v;
    onfloor?.(d.key, v, { final: false });
  }
  function endDrag(e, cancelled = false) {
    const d = drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    drag = null;
    signalDrag(false);
    try { e?.currentTarget?.releasePointerCapture?.(d.id); } catch {}
    if (d.moved) {
      swallowUntil = performance.now() + 80;   // 松手带出来的那一下 click 不算点了点
      lastTap = null;
      const l = lines.find((x) => x.key === d.key);
      const hit = l && l.tier.source !== 'override' ? pickForFloor(cands, d.val) : null;
      if (hit) {
        hold = { key: d.key, pick: pickId(cands[hit.index].model, cands[hit.index].effort), short: hit.short };
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { hold = null; }, 900);
      }
      onfloor?.(d.key, d.val, { final: true });
      return;
    }
    if (cancelled) return;
    const now = performance.now();
    if (lastTap && lastTap.key === d.key && now - lastTap.at < 340) { lastTap = null; onreset?.(d.key); }
    else lastTap = { key: d.key, at: now };
  }
  function onHandleKey(e, l) {
    if (!editable || !view) return;
    const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : e.key === 'ArrowDown' || e.key === 'PageDown' ? -1 : 0;
    if (dir) {
      e.preventDefault();
      // 线高出纵轴时（夹在图顶上画）：↓ 从原值往下走一步，↑ 不动——stepFloor 不会把它夹回纵轴上限
      const v = stepFloor(l.key, dir, floors, { big: e.shiftKey || e.key.startsWith('Page'), min: view.Y0, max: view.Y1 });
      if (v !== floors[l.key]) onfloor?.(l.key, v, { final: true });
    } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onreset?.(l.key); }
  }
  // 手柄上的 touchstart 一律拦掉：老内核不认 SVG 元素上的 touch-action，不拦的话页面会跟着滚
  function grip(node) {
    const stop = (e) => { if (editable) e.preventDefault(); };
    node.addEventListener('touchstart', stop, { passive: false });
    return { destroy() { node.removeEventListener('touchstart', stop); } };
  }
  onDestroy(() => {
    for (const c of chase.values()) c.sp?.cancel();
    clearTimeout(holdTimer);
    if (drag) signalDrag(false);
  });

  // —— 图例：图上出现了哪几家 + 实心 / 空心 / 阶梯各是什么 ——
  const legend = $derived.by(() => {
    const seen = new Map();
    for (const d of cands) {
      if (seen.has(d.vk)) continue;
      const v = vmeta.get(d.vk);
      seen.set(d.vk, { vk: d.vk, slot: d.slot, kind: d.kind, name: v && v.name ? tr(v.name) : d.c.basis === 'plan' ? tr(d.c.provider || '') : d.c.creator || tr(d.c.provider || '') });
    }
    const list = [...seen.values()].filter((v) => v.name);
    return { vendors: list.slice(0, 6), more: Math.max(0, list.length - 6) };
  });
  const colorOf = (slot) => (slot === 'muted' ? 'var(--pc-muted)' : `var(--pc-${slot})`);
  const empty = $derived(!view || (!cands.length && !rows.length));
</script>

<div class="pc" class:dark class:narrow class:dragging class:tween={tweening} bind:this={root}>
  <div class="pc-in">
    {#if empty}
      <div class="pc-empty" style:height="{H}px">
        <p class="e1">{t('还没有性价比数据')}</p>
        <p class="e2">{emptyHint || t('导入「订阅 plan 性价比图」之后，这里会画出能派的模型和四条判定线。')}</p>
      </div>
    {:else if W > 0}
      <!-- 点的悬浮 / 点按在整张图上按「离得最近」找，不靠每个点自己收事件；键盘走点自己的焦点 -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <svg class="pc-svg" bind:this={svgEl} width="100%" height={H} viewBox="0 0 {W} {H}" role="group"
        aria-label={t('性价比图：横轴是每任务成本，纵轴是智力指数，四条横线是四档的判定线')}
        onpointerdown={(e) => { lastType = e.pointerType; }} onpointermove={onMove} onpointerleave={onLeave} onclick={onClick}>
        <defs><clipPath id="{uid}-clip"><rect x={box.l} y={box.t} width={box.w} height={box.h} /></clipPath></defs>

        <!-- 网格、刻度、图版边框 -->
        <g class="grid" aria-hidden="true">
          {#each yt as k (k.s)}
            {@const y = Math.round(k.y) + 0.5}
            <line class="gl" x1={box.l} x2={box.l + box.w} y1={y} y2={y} />
            <line class="tk" x1={box.l} x2={box.l + 5} y1={y} y2={y} />
            <line class="tk" x1={box.l + box.w - 5} x2={box.l + box.w} y1={y} y2={y} />
            <text class="tick" class:hide={lineGeo.some((l) => Math.abs(at(l).py - k.y) < PILL_H / 2 + 5)} x={box.l - 8} y={k.y} dy=".35em" text-anchor="end">{k.s}</text>
          {/each}
          {#each xt.minor as x, i (i)}
            <line class="tk" x1={fx(x)} x2={fx(x)} y1={box.t + box.h} y2={box.t + box.h + 3} />
            <line class="tk" x1={fx(x)} x2={fx(x)} y1={box.t} y2={box.t + 3} />
          {/each}
          {#each xt.major as k (k.v)}
            {@const x = Math.round(k.x) + 0.5}
            <line class="gl" x1={x} x2={x} y1={box.t} y2={box.t + box.h} />
            <line class="tk" x1={x} x2={x} y1={box.t + box.h} y2={box.t + box.h + 6} />
            <line class="tk" x1={x} x2={x} y1={box.t} y2={box.t + 6} />
            {#if k.label}<text class="tick" x={k.x} y={box.t + box.h + 20} text-anchor="middle">¥{fmtTick(k.v)}</text>{/if}
          {/each}
          <rect class="frame" x={box.l + 0.5} y={box.t + 0.5} width={Math.max(0, box.w - 1)} height={Math.max(0, box.h - 1)} />
          <line class="base" x1={box.l} x2={box.l + box.w} y1={box.t + box.h} y2={box.t + box.h} />
          <text class="ax-y" x="2" y="16">{t('智力指数')}</text>
          <text class="ax-x" x={box.l + box.w / 2} y={H - 8} text-anchor="middle">{narrow ? t('每任务成本（元）') : t('每任务成本（元，对数轴）')}</text>
        </g>

        <!-- 全图的点：垫在最底下 -->
        {#if all.paths.length}
          <g class="all" clip-path="url(#{uid}-clip)" aria-hidden="true">
            {#each all.paths as g (g.id)}<path class={g.hollow ? 'o' : 'f'} d={g.d} style:--c={colorOf(g.slot)} />{/each}
          </g>
        {/if}

        <!-- 性价比前沿 -->
        {#if stair}
          <g clip-path="url(#{uid}-clip)" aria-hidden="true">
            <polygon class="front-fill" points={stair.fill} />
            <polyline class="front" points={stair.line} />
          </g>
        {/if}

        <!-- 四条判定线（线身：鼠标可以直接抓） -->
        {#each lineGeo as l (l.key)}
          {@const p = at(l)}
          <g class="tier" class:on={active === l.key} style:--tc={l.meta.color}>
            <line class="tl" class:short={l.short} x1={box.l} x2={box.l + box.w} y1={fx(p.y)} y2={fx(p.y)} />
            {#if editable}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <line class="tl-hit" x1={box.l} x2={box.l + box.w} y1={fx(p.y)} y2={fx(p.y)}
                onpointerdown={(e) => startDrag(e, l, 'line')} onpointermove={moveDrag} onpointerup={endDrag}
                onpointercancel={(e) => endDrag(e, true)} onlostpointercapture={(e) => endDrag(e, true)}
                onpointerenter={(e) => { if (e.pointerType !== 'touch') hoverLine = l.key; }} onpointerleave={() => { if (hoverLine === l.key) hoverLine = ''; }} />
            {/if}
          </g>
        {/each}

        <!-- 候选点 -->
        <g class="dots">
          {#each order as k (dots[k].id)}
            {@const d = dots[k]}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <g class="dot" class:dim={dragging && d.ii < drag.val} class:hov={!!hover && hover.k === k} class:kb={kb && !!hover && hover.k === k}
              class:can={!!onpick && !d.ghost} data-k={k} transform="translate({fx(d.x)} {fx(d.y)})"
              role={onpick && !d.ghost ? 'button' : 'img'} tabindex={k === tabAt ? 0 : -1} aria-label={dotLabel(d)}
              onfocus={() => dotFocus(k)} onblur={() => dotBlur(k)} onkeydown={(e) => onDotKey(e, k)}>
              <circle class="halo" r={R + 7} />
              <circle class="fr" r={(pickedSet.has(k) ? ringR(marks.find((g) => g.k === k).tiers.length - 1) : R) + 4.5} />
              {#if d.ghost}
                <path class="ghost" d={shapePath(d.kind, R)} />
              {:else if d.free}
                <path class="free" d={shapePath(d.kind, R - 1)} style:--c={colorOf(d.slot)} />
              {:else if d.hollow}
                <path class="api" d={shapePath(d.kind, (frontSet.has(k) ? R + 1 : R) - 1)} style:--c={colorOf(d.slot)} />
              {:else}
                <path class="sub" d={shapePath(d.kind, frontSet.has(k) ? R + 1 : R)} style:--c={colorOf(d.slot)} />
              {/if}
            </g>
          {/each}
        </g>

        <!-- 落点：每档一圈环（档位自定义是虚线环），换点时滑过去 -->
        <g aria-hidden="true">
          {#each rings as ring (ring.key)}
            <circle class="ring" class:ov={ring.override} r={ring.r} style:--tc={ring.color} style:transform="translate({fx(ring.x)}px,{fx(ring.y)}px)" />
          {/each}
        </g>

        <!-- 标注 -->
        <g class="labels" aria-hidden="true">
          {#each layout.labels as n (n.id)}
            {#if n.at.far}<line class="leader" x1={fx(n.x)} y1={fx(n.y)} x2={fx(Math.min(Math.max(n.x, n.at.x), n.at.x + n.w))} y2={fx(Math.min(Math.max(n.y, n.at.y), n.at.y + n.h))} />{/if}
            <text class="lbl" x={fx(n.at.x)} y={fx(n.at.y + n.h / 2)} dy=".35em">{n.text}</text>
          {/each}
        </g>
        <g aria-hidden="true">
          {#each layout.caps as c (c.id)}
            <g class="cap" style:transform="translate({fx(c.px)}px,{fx(c.py)}px)">
              {#if c.lead}<line class="leader" x1={fx(c.lead.x1)} y1={fx(c.lead.y1)} x2={fx(c.lead.x2)} y2={fx(c.lead.y2)} />{/if}
              {#each c.tags as tg (tg.key)}
                <rect class="tag" x={tg.x + 0.5} y="0.5" width={tg.w - 1} height={TAG_H - 1} rx="4" style:--tc={tg.color} />
                <text class="tag-t" x={tg.x + tg.w / 2} y={TAG_H / 2} dy=".35em" text-anchor="middle">{tg.name}</text>
              {/each}
              {#if c.text}<text class="cap-t" x={c.textX} y={TAG_H / 2} dy=".35em">{c.text}</text>{/if}
            </g>
          {/each}
        </g>

        <!-- 手柄：档名 + 分值；也是拖动把手与键盘入口 -->
        {#each lineGeo as l (l.key)}
          {@const p = at(l)}
          {@const x0 = box.l - NECK - pillW}
          <g class="th" class:on={active === l.key} class:live={!!drag && drag.key === l.key} class:ro={!editable} style:--tc={l.meta.color}
            transform="translate(0 {fx(p.py)})" use:grip
            role="slider" tabindex={editable ? 0 : -1} aria-orientation="vertical" aria-disabled={!editable}
            aria-label={t('{name}档的判定线', { name: l.meta.title })} aria-valuemin={view.Y0} aria-valuemax={Math.max(view.Y1, l.floor)} aria-valuenow={l.floor}
            aria-valuetext={l.adjusted ? t('智力分 {v}，已调整', { v: fmtScore(l.floor) }) : t('智力分 {v}', { v: fmtScore(l.floor) })}
            onpointerdown={(e) => startDrag(e, l, 'handle')} onpointermove={moveDrag} onpointerup={endDrag}
            onpointercancel={(e) => endDrag(e, true)} onlostpointercapture={(e) => endDrag(e, true)}
            onpointerenter={(e) => { if (e.pointerType !== 'touch') hoverLine = l.key; }} onpointerleave={() => { if (hoverLine === l.key) hoverLine = ''; }}
            onfocus={() => (focusLine = l.key)} onblur={() => { if (focusLine === l.key) focusLine = ''; }} onkeydown={(e) => onHandleKey(e, l)}>
            {#if editable}<title>{t('拖动调整，双击恢复默认')}</title>{/if}
            <rect class="hit" x="0" y={-HIT_H / 2} width={box.l} height={HIT_H} />
            <path class="neck" d="M{fx(box.l - NECK)} 0L{fx(box.l)} {fx(p.y - p.py)}" />
            <rect class="pill" x={x0 + 0.5} y={-PILL_H / 2 + 0.5} width={pillW - 1} height={PILL_H - 1} rx="6" />
            <text class="nm" x={x0 + 7} y="0" dy=".35em">{narrow ? l.meta.short : l.meta.title}</text>
            <text class="val" x={x0 + pillW - 7} y="0" dy=".35em" text-anchor="end">{fmtScore(l.floor)}</text>
            <!-- 「已调整」：骑在标签左上角的一枚角标。不放在档名和读数之间——那里的小圆点会被读成小数点（「常 •45.2」） -->
            {#if l.adjusted}<circle class="adj" cx={x0 + 3} cy={-PILL_H / 2 + 3} r="3.3"><title>{t('已调整')}</title></circle>{/if}
          </g>
        {/each}
      </svg>

      {#if tip}
        <div class="pc-tip" role="tooltip" bind:this={tipEl} style:left="{tipXY ? tipXY.x : 0}px" style:top="{tipXY ? tipXY.y : 0}px" style:visibility={tipXY ? 'visible' : 'hidden'}>
          <div class="tt-h">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path class={tip.hollow ? 'api' : 'sub'} d={shapePath(tip.kind, tip.hollow ? 3.6 : 4.2, 6, 6)} style:--c={colorOf(tip.slot)} /></svg>
            <b>{tip.title}</b>
          </div>
          {#if tip.sub}<div class="tt-s">{tip.sub}</div>{/if}
          <dl>
            <div><dt>{t('智力分')}</dt><dd>{fmtScore(tip.ii)}</dd></div>
            <div><dt>{t('每任务成本')}</dt><dd class:soft={tip.free}>{tip.free ? t('没有价格数据') : fmtCost(tip.cost)}</dd></div>
            {#if tip.basis && !tip.free}<div><dt>{t('计费口径')}</dt><dd class="soft">{tip.basis}</dd></div>{/if}
          </dl>
          {#if tip.tiers.length}<div class="tt-n">{t('现在是 {tiers} 档的落点', { tiers: tip.tiers.join(' / ') })}</div>{/if}
          {#each tip.lent as x (x.tier)}<div class="tt-n">{t('「{tier}」指定的 {name} 没有实测分数，借用这个点的分数与成本', x)}</div>{/each}
          {#if tip.est}<div class="tt-n">{t('这一档没有实测分数，按相邻档位估的')}</div>{/if}
          {#if tip.free}<div class="tt-n">{t('图谱里没有它的价格，贴着左边画，横向位置不代表成本')}</div>{/if}
          {#if tip.hint}<div class="tt-n">{t('再点一下这个点，把它指定给某一档')}</div>{/if}
        </div>
      {/if}

      <div class="pc-legend" style:padding-left="{box.l}px" aria-hidden="true">
        {#each legend.vendors as v (v.vk)}
          <span class="pc-lgi"><svg width="11" height="11" viewBox="0 0 12 12"><path class="sub" d={shapePath(v.kind, 4.2, 6, 6)} style:--c={colorOf(v.slot)} /></svg>{v.name}</span>
        {/each}
        {#if legend.more}<span class="pc-lgi">{t('另有 {n} 家', { n: legend.more })}</span>{/if}
        <span class="pc-lgi sep"><svg width="11" height="11" viewBox="0 0 12 12"><circle class="k-sub" cx="6" cy="6" r="4.2" /></svg>{t('订阅 / plan 价')}</span>
        <span class="pc-lgi"><svg width="11" height="11" viewBox="0 0 12 12"><circle class="k-api" cx="6" cy="6" r="3.6" /></svg>{t('API 价')}</span>
        <span class="pc-lgi"><svg width="16" height="11" viewBox="0 0 16 12"><polyline class="k-front" points="1,10 6,10 6,5 11,5 11,2 15,2" /></svg>{t('性价比前沿')}</span>
        {#if all.paths.length}<span class="pc-lgi"><svg width="11" height="11" viewBox="0 0 12 12"><circle class="k-all" cx="6" cy="6" r="3" /></svg>{t('图谱里的全部点')}</span>{/if}
      </div>
    {:else}
      <div style:height="{H}px"></div>
    {/if}
  </div>
</div>

<style>
  /* 只向外壳要两样：墨色与卡片底色（子页根的 --dp-*，没有就直接读外壳的），其余深浅都由它俩调出来 */
  .pc {
    --pc-ink: var(--dp-ink, var(--i-label, var(--dsk-ink, #1d1b18)));
    --pc-surface: var(--dp-chart-bg, var(--dp-card, var(--i-card, var(--dsk-panel, #fcfbf8))));
    --pc-pop: var(--dp-raised, var(--dsk-bg-raised, var(--i-card, #ffffff)));
    --pc-muted: color-mix(in srgb, var(--pc-ink) 58%, transparent);
    --pc-faint: color-mix(in srgb, var(--pc-ink) 36%, transparent);
    --pc-axis: color-mix(in srgb, var(--pc-ink) 30%, transparent);
    --pc-frame: color-mix(in srgb, var(--pc-ink) 13%, transparent);
    --pc-grid: color-mix(in srgb, var(--pc-ink) 6.5%, transparent);
    --pc-front: color-mix(in srgb, var(--pc-ink) 84%, transparent);
    --pc-front-fill: color-mix(in srgb, var(--pc-ink) 3.5%, transparent);
    /* 厂商点色：原图的八个槽位 */
    --pc-s1: #2a78d6; --pc-s2: #eb6834; --pc-s3: #1baf7a; --pc-s4: #eda100;
    --pc-s5: #e87ba4; --pc-s6: #008300; --pc-s7: #4a3aa7; --pc-s8: #e34948;
    /* 四档：子页根给了就用它的，没给用同一份色值兜底（lib/dispatchPolicy.svelte.js 的 TIER_COLORS） */
    --pc-t-top: var(--dp-t-top, #004458); --pc-t-hard: var(--dp-t-hard, #006b7f);
    --pc-t-normal: var(--dp-t-normal, #3192a0); --pc-t-light: var(--dp-t-light, #72b5b9);
    position: relative; width: 100%; min-width: 0; color: var(--pc-ink);
    font-variant-numeric: tabular-nums; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
  }
  .pc.dark {
    --pc-ink: var(--dp-ink, var(--i-label, var(--dsk-ink, #f1ece2)));
    --pc-surface: var(--dp-chart-bg, var(--dp-card, var(--i-card, var(--dsk-panel, #1a1917))));
    --pc-pop: var(--dp-raised, var(--dsk-bg-raised, var(--i-card, #262420)));
    --pc-s1: #3987e5; --pc-s2: #d95926; --pc-s3: #199e70; --pc-s4: #c98500;
    --pc-s5: #d55181; --pc-s6: #008300; --pc-s7: #9085e9; --pc-s8: #e66767;
    --pc-t-top: var(--dp-t-top, #a3eaea); --pc-t-hard: var(--dp-t-hard, #58c5d0);
    --pc-t-normal: var(--dp-t-normal, #329cae); --pc-t-light: var(--dp-t-light, #287286);
  }
  /* 里面这一层把四档变量落定：图里一律直接写 var(--dp-t-*)（TIER_META.color） */
  .pc-in {
    position: relative;
    --dp-t-top: var(--pc-t-top); --dp-t-hard: var(--pc-t-hard); --dp-t-normal: var(--pc-t-normal); --dp-t-light: var(--pc-t-light);
  }
  .pc-svg { display: block; overflow: visible; }
  .pc-svg text { font-family: inherit; }

  /* 网格与坐标轴：退到最后面 */
  .gl { stroke: var(--pc-grid); shape-rendering: crispEdges; }
  .tk, .base { stroke: var(--pc-axis); shape-rendering: crispEdges; }
  .frame { fill: none; stroke: var(--pc-frame); shape-rendering: crispEdges; }
  .tick { fill: var(--pc-muted); font-size: 11.5px; transition: opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .narrow .tick { font-size: 11px; }
  .tick.hide { opacity: 0; }
  .ax-y { fill: var(--pc-ink); font-size: 12px; font-weight: 650; }
  .ax-x { fill: var(--pc-muted); font-size: 12px; }

  /* 全图：小、淡 */
  .all path { opacity: .2; }
  .all .f { fill: var(--c); }
  .all .o { fill: none; stroke: var(--c); stroke-width: 1.2; }

  /* 前沿 */
  .front { fill: none; stroke: var(--pc-front); stroke-width: 2; stroke-linejoin: miter; }
  .front-fill { fill: var(--pc-front-fill); }

  /* 判定线 */
  .tl { stroke: var(--tc); stroke-width: 1.5; transition: stroke-width var(--mo-micro, 140ms) var(--ea-std, ease); }
  .tl.short { stroke-dasharray: 2 4; }
  .tier.on .tl { stroke-width: 2.25; }
  .tl-hit { stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: ns-resize; }

  /* 点 */
  .dot { outline: none; transition: opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .dot.can { cursor: pointer; }
  .dot.dim { opacity: .35; }
  .dot .sub, .pc-tip .sub, .pc-legend .sub { fill: var(--c); stroke: var(--pc-surface); stroke-width: 2; }
  .dot .api, .pc-tip .api { fill: var(--pc-surface); stroke: var(--c); stroke-width: 2.2; }
  .pc-tip .sub, .pc-legend .sub { stroke: none; }
  .pc-tip .api { fill: none; stroke-width: 1.6; }
  .dot .ghost { fill: var(--pc-surface); stroke: var(--pc-muted); stroke-width: 1.4; stroke-dasharray: 2.4 2; }
  /* 没有价格的候选：厂商色的虚线空心点（虚线 = 位置不是实测出来的，和估出来的虚点同一个说法） */
  .dot .free { fill: var(--pc-surface); stroke: var(--c); stroke-width: 1.8; stroke-dasharray: 2.4 2; }
  .halo { fill: var(--pc-ink); opacity: 0; transition: opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .dot.hov .halo { opacity: .1; }
  .fr { fill: none; stroke: var(--pc-ink); stroke-width: 1.5; opacity: 0; }
  .dot.kb .fr { opacity: 1; }

  /* 落点的环与档名签：换点时滑过去；坐标轴自己在动的那几帧不叠过渡 */
  .ring { fill: none; stroke: var(--tc); stroke-width: 1.75; pointer-events: none; transition: transform var(--mo-quick, 200ms) var(--ea-std, ease); }
  .ring.ov { stroke-dasharray: 3.2 2.6; }
  .cap { pointer-events: none; transition: transform var(--mo-quick, 200ms) var(--ea-std, ease); }
  .tween .ring, .tween .cap { transition: none; }
  .tag { fill: var(--pc-surface); stroke: var(--tc); stroke-width: 1.25; }
  .tag-t { fill: var(--pc-ink); font-size: 10.5px; font-weight: 600; }
  .cap-t, .lbl { font-size: 11px; paint-order: stroke; stroke: var(--pc-surface); stroke-width: 3.5px; stroke-linejoin: round; }
  .cap-t { fill: var(--pc-ink); font-weight: 500; }
  .lbl { fill: var(--pc-muted); }
  .leader { stroke: var(--pc-axis); stroke-width: 1; }
  .labels { pointer-events: none; transition: opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .dragging .labels { opacity: 0; }

  /* 手柄 */
  .th { outline: none; cursor: ns-resize; touch-action: none; }
  .th.ro { cursor: default; touch-action: auto; }
  .th .hit { fill: transparent; }
  .neck { fill: none; stroke: var(--tc); stroke-width: 1.5; transition: stroke-width var(--mo-micro, 140ms) var(--ea-std, ease); }
  .pill {
    fill: color-mix(in srgb, var(--tc) 12%, var(--pc-surface)); stroke: var(--tc); stroke-width: 1;
    transition: fill var(--mo-tap, 90ms) var(--ea-out, ease-out), stroke-width var(--mo-tap, 90ms) var(--ea-out, ease-out);
  }
  .th.on .pill { fill: color-mix(in srgb, var(--tc) 22%, var(--pc-surface)); }
  .th.on .neck { stroke-width: 2.25; }
  .th.live .pill { fill: color-mix(in srgb, var(--tc) 32%, var(--pc-surface)); stroke-width: 1.75; }
  .th:focus-visible .pill { stroke: var(--pc-ink); stroke-width: 1.75; }
  .nm { fill: var(--pc-muted); font-size: 11px; font-weight: 500; }
  .val { fill: var(--pc-ink); font-size: 11.5px; font-weight: 600; }
  /* 角标外面一圈底色，把它和标签的边框分开 */
  .adj { fill: var(--pc-ink); stroke: var(--pc-surface); stroke-width: 1.5; }

  /* 提示框：数值在前，名目在后 */
  .pc-tip {
    position: absolute; z-index: 3; pointer-events: none; box-sizing: border-box; min-width: 152px; max-width: 236px; padding: 9px 11px 10px;
    border-radius: 10px; background: var(--pc-pop); color: var(--pc-ink); font-size: 12px; line-height: 1.45;
    box-shadow: inset 0 0 0 1px var(--pc-frame), 0 12px 28px -14px rgba(0, 0, 0, .45), 0 2px 6px rgba(0, 0, 0, .08);
  }
  .tt-h { display: flex; align-items: baseline; gap: 6px; }
  .tt-h svg { flex: none; align-self: center; }
  .tt-h b { font-weight: 600; overflow-wrap: anywhere; }
  .tt-s { margin: 1px 0 0 18px; color: var(--pc-muted); font-size: 11.5px; overflow-wrap: anywhere; }
  .pc-tip dl { margin: 7px 0 0; padding: 6px 0 0; box-shadow: inset 0 1px 0 var(--pc-frame); }
  .pc-tip dl div { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
  .pc-tip dt { color: var(--pc-muted); white-space: nowrap; }
  .pc-tip dd { margin: 0; font-weight: 600; white-space: nowrap; }
  .pc-tip dd.soft { font-weight: 500; }
  .tt-n { margin-top: 6px; color: var(--pc-muted); font-size: 11.5px; }

  /* 图例 */
  .pc-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 14px; padding-top: 4px; padding-right: 8px; color: var(--pc-muted); font-size: 11px; line-height: 16px; }
  .pc-lgi { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .pc-lgi.sep { margin-left: 4px; }
  .pc-lgi svg { flex: none; }
  .k-sub { fill: var(--pc-muted); }
  .k-api { fill: none; stroke: var(--pc-muted); stroke-width: 1.6; }
  .k-front { fill: none; stroke: var(--pc-front); stroke-width: 1.6; }
  .k-all { fill: var(--pc-faint); }

  /* 空态 */
  .pc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 0 24px; box-sizing: border-box; text-align: center; }
  .pc-empty p { margin: 0; }
  .e1 { font-size: 15px; font-weight: 600; }
  .e2 { max-width: 34em; color: var(--pc-muted); font-size: 12.5px; line-height: 1.5; text-wrap: pretty; }
</style>
