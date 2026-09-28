<script>
  // 官方 /code 页「单条工具行」（c360a9e1c OF 的非 Agent 分支 + 展开体 nM/iM，规格
  // agent-tool-card.md §2.3 / §2.5）：动词 + meta（文件名 / 命令描述 / pattern / url…）+
  // 尾巴（Failed / Stopped / Denied），点开看 input 参数表。
  //
  // 状态语义（§2.4）：
  //   · running（650ms 防抖）→ runningVerb / runningLabel + 流光；
  //   · error → failedVerb（"Failed to read"）或 failedLabel（"Failed to fix login bug"），红；
  //     没有可用的失败文案（"Used X" 类）才退成 verb 红 + 尾巴 "Failed"（bridge 小偏离：官方对
  //     非 Agent 工具不挂 Failed 尾巴，但那样一句红字 "Used foo" 看不出是失败）；
  //   · 轮中断（interrupted）→ verb + 尾巴 "Stopped"，不算失败；后台 shell 的任务 stopped 同理；
  //   · 后台化的 Bash（run_in_background）在任务确认 completed 前不用 doneLabel。
  // run：ToolGroup 按官方 hF 并进来的「同一文件连续读写」——一行代表整个 run，Read 带行号
  // 范围 "(1–200, 201–400)"，展开体逐个列参数。
  import { untrack } from 'svelte';
  import { toolVerb, morphText } from '../../lib/toolVerbs.js';
  import { taskRunning } from '../../lib/taskModel.js';
  import { glyph } from '../../lib/claudeIcons.js';

  let { tool, run = undefined, inGroup = false, live = false } = $props();

  const tools = $derived(Array.isArray(run) && run.length ? run : [tool]);
  const d = $derived(toolVerb(tool));
  const task = $derived(tool.task || null);

  const anyRunning = $derived(tools.some((t) => t.status === 'running'));
  const anyError = $derived(tools.some((t) => t.status === 'error'));
  const allError = $derived(tools.length > 0 && tools.every((t) => t.status === 'error'));
  const interrupted = $derived(tools.some((t) => !!t.interrupted));
  const rejected = $derived(tools.some((t) => !!(t.rejected || t.denied)));
  // 工具结果已回但后台任务（后台 Bash）仍在跑 → 用任务状态（官方 U）
  const U = $derived(!anyRunning && task ? task.status : undefined);
  const H = $derived(!!live && (anyRunning || taskRunning(U)));
  // 官方 Wh(…, 650)：运行态切换稳定 650ms 后才落到显示（快工具不闪）；首帧取当前值
  let V = $state(untrack(() => H));
  $effect(() => {
    const v = H;
    if (v === V) return;
    const timer = setTimeout(() => { V = v; }, 650);
    return () => clearTimeout(timer);
  });

  const stopped = $derived(U === 'stopped');
  const B = $derived(anyError || U === 'failed' || stopped);
  const le = $derived((allError || U === 'failed') && !interrupted && !rejected);
  const de = $derived(!d.doneLabelNeedsBackgroundConfirmation || U === 'completed');
  // 整句标签优先（官方 ce）：running → runningLabel；失败 → failedLabel；完成 → doneLabel
  const ce = $derived(stopped ? undefined : V ? d.runningLabel : B ? (le ? d.failedLabel : undefined) : de ? d.doneLabel : undefined);
  const ue = $derived(B && !stopped && le ? d.failedVerb : undefined);
  const verbText = $derived(ce ?? (V ? d.runningVerb : (ue ?? d.verb)));
  const showMeta = $derived(!!d.meta && !ce);
  const metaPrimary = $derived(!!(d.metaIsPath || d.metaIsCode));
  const danger = $derived(!V && B && !stopped && !interrupted && !rejected);
  const tail = $derived(V || (!stopped && !interrupted)
    ? (!V && rejected ? 'Denied' : (!V && B && !ce && !ue ? 'Failed' : ''))
    : 'Stopped');

  // 合并 Read 的行号范围（官方 Z）：每条 offset/limit → "a–b"，全部有值才显示
  const ranges = $derived.by(() => {
    const rs = tools.map((t) => {
      const inp = t.input || {};
      if (inp.offset === undefined && inp.limit === undefined) return null;
      const s = Number(inp.offset) || 1;
      const l = Number(inp.limit);
      return l > 0 ? `${s}–${s + l - 1}` : `${s}–`;
    });
    return rs.length && rs.every(Boolean) ? `(${rs.join(', ')})` : '';
  });

  // —— 展开体：input 参数表（官方 iM）——路径用等宽 chip、命令/pattern 等宽块（Bash 前缀 "$ "）
  const ORDER = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'glob', 'url', 'query', 'description',
    'prompt', 'subagent_type', 'run_in_background', 'skill', 'subject', 'name', 'offset', 'limit', 'todosCount'];
  const CHIP = new Set(['file_path', 'notebook_path', 'path']);
  const CODE = new Set(['command', 'cmd', 'script', 'shell', 'code', 'pattern', 'regex', 'glob']);
  function paramsOf(t) {
    const inp = t.input && typeof t.input === 'object' ? t.input : {};
    const keys = Object.keys(inp).filter((k) => inp[k] !== undefined && inp[k] !== null && inp[k] !== '');
    keys.sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return ((ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)) || a.localeCompare(b);
    });
    return keys.map((k) => {
      const v = inp[k];
      let key = k, value = typeof v === 'string' ? v : JSON.stringify(v);
      if (k === 'todosCount') { key = 'todos'; value = `${v} ${Number(v) === 1 ? 'item' : 'items'}`; }
      return { key, value, chip: CHIP.has(k), code: CODE.has(k), prefix: k === 'command' ? (t.name === 'PowerShell' ? '> ' : '$ ') : '' };
    });
  }
  const bodies = $derived(tools.map((t) => ({ tool: t, params: paramsOf(t) })));
  const hasParams = $derived(bodies.some((b) => b.params.length > 0));
  // 没有参数子集可列时退回服务端摘要（summary）——与 meta 相同就不重复
  const summaryLine = $derived.by(() => {
    const s = String(tool.summary || '').trim();
    return !hasParams && s && s !== d.meta ? s : '';
  });
  const expandable = $derived(hasParams || !!summaryLine);

  let open = $state(false);
  let mounted = $state(false);   // 首次展开后保持挂载（官方 Ny）
  function toggle() { if (!expandable) return; open = !open; if (open) mounted = true; }
  function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
</script>

<div class="wrap" class:ingroup={inGroup}>
  <div class="row" class:expandable={expandable} role="button" tabindex="0" aria-expanded={expandable ? open : undefined} onclick={toggle} onkeydown={onKey}>
    <span class="verb" class:cl-shine={V} class:danger={danger} class:trunc={!!ce} class:nowrap={!ce} use:morphText={verbText}>{verbText}</span>
    {#if showMeta}
      {#if d.metaHref}
        <a class="meta pri trunc" href={d.metaHref} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}>{d.meta}</a>
      {:else}
        <span class="meta trunc" class:pri={metaPrimary} class:code={d.metaIsCode}>{d.meta}</span>
      {/if}
    {/if}
    {#if tail}<span class="tail" class:danger={tail === 'Failed'}>{tail}</span>{/if}
    {#if ranges}<span class="rng trunc">{ranges}</span>{/if}
    {#if H}<span class="sr-only">running</span>{/if}
    {#if expandable}<span class="ic caret" aria-hidden="true">{glyph(open ? 'CaretDown' : 'CaretRight')}</span>{/if}
  </div>
  {#if mounted}
    <div class="body" class:card={!inGroup} hidden={!open}>
      {#each bodies as b, i (b.tool.id || i)}
        <div class="params" class:sep={i > 0}>
          {#each b.params as p (p.key)}
            <div class="param">
              <span class="key">{p.key}:</span>
              {#if p.chip}<code class="chip">{p.value}</code>
              {:else if p.code}<span class="code">{#if p.prefix}<span class="pfx">{p.prefix}</span>{/if}{p.value}</span>
              {:else}<span class="val">{p.value}</span>{/if}
            </div>
          {/each}
        </div>
      {/each}
      {#if summaryLine}<div class="params"><div class="param"><span class="val">{summaryLine}</span></div></div>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 4px 0; }
  .wrap.ingroup { margin: 0; }   /* 分组卡里由容器给 8px 10px */
  /* 文本行（官方 OF 形态 B）：gap 3px、r4、secondary 字色，hover 整体转 primary */
  .row {
    position: relative; display: flex; align-self: flex-start; max-width: 100%; min-width: 0; align-items: center; gap: 3px;
    padding: 0; text-align: left; border-radius: 4px; outline: none; color: var(--serif); font-size: 14px; line-height: 20px;
    -webkit-tap-highlight-color: transparent; transition: color var(--mo-micro, 140ms);
  }
  .row.expandable { cursor: pointer; }
  .row:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  @media (hover: hover) { .row.expandable:hover { color: var(--text); } }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .nowrap { flex: none; white-space: nowrap; }
  .danger { color: var(--crit); }
  /* meta：文件路径 / 代码类恒 primary；其它跟随行色（secondary → hover primary） */
  .meta { color: inherit; }
  .meta.pri { color: var(--text); }
  .meta.code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
  a.meta { text-decoration: none; }
  a.meta:hover { text-decoration: underline; text-underline-offset: 3px; }
  .tail { flex: none; }
  .rng { color: inherit; }
  /* 展开箭头（官方 My customSize 14）：字体图标，可变字重 570 ≈ 14px 下的描边粗细 */
  .caret {
    flex: none; width: 1em; height: 1em; font-size: 14px; font-weight: 570;
    display: flex; align-items: center; justify-content: center; font-feature-settings: "liga" 0;
  }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

  /* 展开体（官方 Xk 壳）：分组卡里只加 4px 上距；单独一行时自带描边小卡 */
  .body[hidden] { display: none; }
  .body.card { margin-top: 6px; padding: 8px 10px; border-radius: 8px; box-shadow: 0 0 0 1px var(--divider); overflow: hidden; }
  .body:not(.card) { padding-top: 4px; }
  .params { display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--serif); font-size: 13px; line-height: 18px; }
  .params.sep { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--divider); }
  .param { min-width: 0; overflow-wrap: anywhere; }
  .key { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; opacity: .7; margin-right: 4px; }
  .chip { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; padding: 1px 5px; border-radius: 4px; background: var(--hover); color: var(--text); word-break: break-all; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; line-height: 17px; white-space: pre-wrap; word-break: break-all; color: var(--text); }
  .pfx { user-select: none; color: var(--serif); }
  .val { white-space: pre-wrap; }
</style>
