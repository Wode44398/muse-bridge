<script>
  // 审批 / 提问面板：输入栏原地变成它（变形由 Composer 编排，这里只管内容和选择）。
  // 选项竖着排，一块高亮底跟着 ↑↓ 或鼠标滑过去，当前那项的数字键变实心；数字键直接选，回车选当前。
  // 按下的那项先往回收（110ms）再作答；拒绝时在这一项下面长出输入框：写了理由 = 拒绝后再插一句话。
  import { untrack, tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import { displayCommand, diffStat } from '../../lib/codex/turns.js';
  import { permOptions, ruleText, relPath, diffLines, questionAnswer, questionPayload } from '../../lib/codex/composer/logic.js';
  import { growY } from '../../lib/codex/composer/fx.js';
  import { reduced } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';

  let {
    ask,                   // th.ask 的快照（kind:'perm' | 'question'）
    active = false,        // 面板正显示着（键盘只在这时接管）
    admin = false,
    root = '',             // 项目路径：工作目录写成相对它的
    onanswer,              // (payload, pickedIndex, { steer? }) => Promise<string>（'' = 成功）
  } = $props();

  let list = $state(null);
  let hl = $state(null);
  let cur = $state(0);
  let pressed = $state(-1);
  let denying = $state(false);
  let denyText = $state('');
  let busy = $state(false);
  let err = $state('');
  let copied = $state(false);

  // 提问：第几题、每题的作答、当前题的多选与自己写的
  let qi = $state(0);
  let answers = $state([]);
  let picked = $state([]);
  let custom = $state('');

  const isPerm = $derived(ask?.kind === 'perm');
  const pv = $derived(ask?.preview || {});
  const questions = $derived(Array.isArray(ask?.questions) ? ask.questions : []);
  const q = $derived(questions[qi] || null);
  const multi = $derived(!!q?.multiSelect);

  const opts = $derived(
    isPerm
      ? permOptions(ask, { admin })
      : (q?.options || []).map((o) => ({ key: 'opt', label: o.label, desc: o.description })),
  );

  const cmd = $derived(pv.kind === 'command' ? displayCommand(pv.command || ask?.description || '') : '');
  const cwd = $derived(pv.cwd ? relPath(pv.cwd, root) : '');
  const rule = $derived(ruleText(ask));
  // 「在 src/ 里运行」：目录用等宽字，句子整句翻译后再从占位处切开
  const runIn = $derived(t('在 {dir} 里运行').split('{dir}'));
  const files = $derived(
    pv.kind === 'edit' && Array.isArray(pv.files)
      ? pv.files.map((f) => ({ ...f, ...diffStat(f.diff, f.kind || 'update'), view: diffLines(f.diff) }))
      : [],
  );
  const fields = $derived(Array.isArray(pv.fields) ? pv.fields.filter((r) => Array.isArray(r) && r.length >= 2) : []);

  const icon = $derived(
    !isPerm ? 'msg' : pv.kind === 'command' ? 'term' : pv.kind === 'edit' ? 'edit' : pv.kind === 'fields' ? 'shield' : pv.kind === 'mcp' ? 'sliders' : 'bridge',
  );
  const title = $derived(
    !isPerm
      ? (tr(q?.header) || t('Codex 想问你'))
      : pv.kind === 'command' ? t('允许 Codex 运行这条命令吗？')
        : pv.kind === 'edit' ? t('允许 Codex 修改这些文件吗？')
          : (tr(ask?.title) || t('允许 Codex 继续吗？')),
  );
  const sub = $derived.by(() => {
    if (!isPerm) return questions.length > 1 ? t('第 {i} / {n} 个问题', { i: qi + 1, n: questions.length }) : '';
    if (pv.kind === 'command' && pv.network) return t('要联网');
    if (pv.kind === 'edit') return files.length ? t('{n} 个文件', { n: files.length + (pv.more || 0) }) : '';
    if (pv.kind === 'mcp') return [pv.server, pv.tool].filter(Boolean).join(' · ');
    if (pv.kind === 'tool') return [pv.namespace, pv.tool].filter(Boolean).join('.');
    return '';
  });

  function optLabel(o) {
    if (o.key === 'once') return t('允许一次');
    if (o.key === 'always') return t('这个对话都允许');
    if (o.key === 'rule') return t('按前缀规则允许');
    if (o.key === 'deny') return t('拒绝');
    return tr(o.label);
  }
  function optDesc(o) {
    if (o.key === 'always') return pv.kind === 'command' ? t('这条线程里同类命令不再问') : t('这条线程里同类操作不再问');
    if (o.key === 'rule') return t('以后匹配这个前缀的命令都不再问（所有线程）');
    if (o.key === 'deny') return t('并告诉 Codex 怎么做');
    return o.desc ? tr(o.desc) : '';
  }

  // 换了一张卡：从头来
  $effect(() => {
    void ask?.qid;
    untrack(() => {
      cur = 0; pressed = -1; denying = false; denyText = ''; busy = false; err = ''; copied = false;
      qi = 0; answers = []; picked = []; custom = '';
    });
  });

  /* ---------------- 高亮底块 ---------------- */
  function placeHl(instant) {
    if (!list || !hl) return;
    const els = list.querySelectorAll('.aopt');
    const o = els[cur];
    if (!o) { hl.style.opacity = '0'; return; }
    hl.style.opacity = '';
    if (instant || reduced()) hl.style.transition = 'none';
    hl.style.transform = `translateY(${o.offsetTop}px)`;
    hl.style.height = o.offsetHeight + 'px';
    if (instant || reduced()) { void hl.offsetHeight; hl.style.transition = ''; }
  }
  let placedFor = '';
  $effect(() => {
    void cur; void opts.length; void denying; void qi; void active;
    const key = (ask?.qid || '') + ':' + qi;
    const instant = key !== placedFor;
    placedFor = key;
    tick().then(() => requestAnimationFrame(() => placeHl(instant)));
  });

  function setCur(i) {
    const n = opts.length;
    if (!n) return;
    cur = (i + n) % n;
  }

  /* ---------------- 作答 ---------------- */
  async function submit(payload, idx, extra = {}) {
    if (busy) return;
    busy = true;
    err = '';
    const e = await onanswer?.(payload, idx, extra);
    busy = false;
    if (e) { err = e; haptic('error'); }
  }

  function press(i) {
    if (busy || pressed >= 0) return;
    setCur(i);
    if (reduced()) { act(i); return; }
    pressed = i;
    setTimeout(() => { pressed = -1; act(i); }, 110);
  }

  async function act(i) {
    const o = opts[i];
    if (!o) return;
    if (isPerm) {
      if (o.key === 'deny') {
        if (denying) { sendDeny(); return; }
        denying = true;
        await tick();
        setTimeout(() => list?.querySelector('.deny-box input')?.focus({ preventScroll: true }), 60);
        return;
      }
      submit({ decision: o.key }, i);
      return;
    }
    // 提问：单选点了就答这一题；多选是勾上 / 去掉
    if (multi) {
      picked = picked.includes(o.label) ? picked.filter((x) => x !== o.label) : [...picked, o.label];
      return;
    }
    commitQuestion([o.label], i);
  }

  function sendDeny() {
    const idx = opts.findIndex((o) => o.key === 'deny');
    submit({ decision: 'deny' }, idx, { steer: denyText.trim() });
  }
  function denyKey(e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendDeny(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      denying = false;
      list?.querySelectorAll('.aopt')[cur]?.focus({ preventScroll: true });
    }
  }

  function commitQuestion(sel, idx = -1) {
    const a = questionAnswer(q, sel ?? picked, custom);
    if (!a) { err = t('选一项，或者自己写一句'); return; }
    const next = [...answers];
    next[qi] = a;
    answers = next;
    const payload = questionPayload(next, questions.length);
    if (payload) { submit(payload, idx); return; }
    // 下一题：内容换一下，高亮回到第一项
    qi += 1;
    picked = [];
    custom = '';
    cur = 0;
    err = '';
  }
  function customKey(e) {
    if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) { e.preventDefault(); commitQuestion(multi ? picked : []); }
  }

  function skip() { submit({ cancelled: true }, -1); }

  async function copy() {
    try { await navigator.clipboard.writeText(cmd); copied = true; setTimeout(() => { copied = false; }, 900); } catch {}
  }

  /** 打开时：焦点落在第一项（键盘直接能选）。 */
  export function focusFirst() {
    list?.querySelector('.aopt')?.focus({ preventScroll: true });
  }

  // 键盘：↑↓ 移、回车选当前、数字键直接选。焦点在输入框里（拒绝理由、自己写）时不抢；
  // 带修饰键的回车（比如 Ctrl+回车 稍后发送）不能顺手把命令批了。
  $effect(() => {
    if (!active) return;
    const onKey = (e) => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (denying || busy) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setCur(cur + (e.key === 'ArrowDown' ? 1 : -1)); return; }
      if (e.key === 'Enter') { if (document.activeElement?.closest?.('.aopt') || document.activeElement === document.body || list?.contains(document.activeElement)) { e.preventDefault(); press(cur); } return; }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= opts.length) { e.preventDefault(); press(n - 1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

{#if ask}
  <div class="ask-hd">
    <span class="ask-ico sq"><Icon name={icon} /></span>
    <div class="ask-ttl"><b>{title}</b>{#if sub}<span>{sub}</span>{/if}</div>
    {#if !isPerm}
      <button type="button" class="tbtn" disabled={busy} onclick={skip}>{t('不回答')}</button>
    {/if}
  </div>

  {#if isPerm && pv.kind === 'command'}
    <div class="ask-cmd sq">
      <span class="pfx">$</span><span class="c">{cmd}</span>
      <button type="button" class="ibtn sm" title={copied ? t('已复制') : t('复制命令')} aria-label={t('复制命令')} onclick={copy}><Icon name={copied ? 'check' : 'copy'} /></button>
    </div>
  {:else if isPerm && pv.kind === 'edit'}
    <div class="ask-diff sq">
      {#each files as f (f.path)}
        <div class="df-hd"><span class="p mono">{f.path}</span><span class="s"><span class="a">+{f.a}</span> <span class="d">−{f.d}</span></span></div>
        {#if f.view.lines.length}
          <div class="df-body mono">
            {#each f.view.lines as l, k (k)}<div class="ln {l.k}">{l.text || ' '}</div>{/each}
          </div>
        {/if}
      {/each}
      {#if pv.more}<div class="df-more">{t('还有 {n} 个文件', { n: pv.more })}</div>{/if}
    </div>
  {:else if isPerm && fields.length}
    <div class="ask-kv sq">
      {#each fields as [k, v], i (i)}<div class="kv"><span class="k mono">{k}</span><span class="v mono">{v}</span></div>{/each}
    </div>
  {/if}

  {#if isPerm}
    {#if ask.reason || cwd || (ask.description && pv.kind !== 'command')}
      <p class="ask-why">
        {#if ask.reason}{tr(ask.reason)}{:else if ask.description && pv.kind !== 'command'}{tr(ask.description)}{/if}
        {#if cwd && cwd !== '.'}<span class="dim">{ask.reason ? ' · ' : ''}{runIn[0]}</span><span class="mono">{cwd}/</span><span class="dim">{runIn[1] || ''}</span>{:else if cwd === '.'}<span class="dim">{ask.reason ? ' · ' : ''}{t('在项目根目录运行')}</span>{/if}
      </p>
    {:else}
      <div class="gap"></div>
    {/if}
  {:else}
    <p class="ask-why">
      {tr(q?.question) || tr(ask.message) || ''}
      {#if ask.url}<a class="ask-url" href={ask.url} target="_blank" rel="noopener noreferrer">{t('打开链接')}</a>{/if}
    </p>
  {/if}

  <div class="ask-list" class:denying bind:this={list} role="listbox" aria-label={title}>
    <span class="ask-hl sq" bind:this={hl}></span>
    {#each opts as o, i (qi + ':' + i + ':' + o.key)}
      <button
        type="button"
        class="aopt"
        class:deny={o.key === 'deny'}
        class:cur={i === cur}
        class:press={pressed === i}
        role="option"
        aria-selected={i === cur}
        aria-checked={multi ? picked.includes(o.label) : undefined}
        disabled={busy}
        onclick={() => press(i)}
        onpointerenter={(e) => { if (e.pointerType !== 'touch' && !denying) setCur(i); }}
        onfocus={() => { if (!denying) setCur(i); }}
      >
        <kbd>{i + 1}</kbd>
        <span class="l">{optLabel(o)}{#if o.key === 'rule' && rule}<code>{rule}</code>{/if}</span>
        <span class="d">{optDesc(o)}</span>
        {#if multi}<span class="mk" class:on={picked.includes(o.label)}><Icon name="check" size={16} /></span>{:else}<span class="ent">⏎</span>{/if}
      </button>
      {#if o.key === 'deny' && denying}
        <div class="deny-box" transition:growY={{ dur: 360 }}>
          <div class="sq">
            <input bind:value={denyText} placeholder={t('告诉 Codex 怎么做（回车发送 · Esc 返回）')} onkeydown={denyKey} aria-label={t('拒绝的理由')} />
            <button type="button" class="tbtn pri" disabled={busy} onclick={sendDeny}>{denyText.trim() ? t('拒绝并发送') : t('拒绝')}</button>
          </div>
        </div>
      {/if}
    {/each}
  </div>

  {#if !isPerm}
    <div class="ask-free sq">
      <input
        type={q?.isSecret ? 'password' : 'text'}
        autocomplete={q?.isSecret ? 'off' : undefined}
        bind:value={custom}
        placeholder={opts.length ? t('或者自己写…') : t('写下你的回答…')}
        onkeydown={customKey}
        aria-label={t('自己写的回答')}
      />
      {#if multi || custom.trim() || !opts.length}
        <button type="button" class="tbtn pri" disabled={busy || (!custom.trim() && !picked.length)} onclick={() => commitQuestion(multi ? picked : [])}>
          {qi + 1 < questions.length ? t('下一题') : t('提交')}
        </button>
      {/if}
    </div>
  {/if}

  {#if err}<p class="ask-err" role="alert"><Icon name="warn" size={14} />{err}</p>{/if}
{/if}

<style>
  .gap { height: 12px; }
  .ask-cmd .c { max-height: min(240px, 32vh); overflow-y: auto; }
  .ask-hd .tbtn { flex: none; color: var(--fg2); font-weight: 400; }
  .ask-url { margin-left: 6px; color: var(--link); text-decoration: none; }
  .ask-url:hover { text-decoration: underline; }
  /* 改动预览：文件头 + 补丁行，长了在框里滚 */
  .ask-diff { margin: 0 4px; max-height: min(280px, 36vh); overflow: auto; background: var(--term); border: 1px solid var(--line1); --r: 12px; font-size: 12.5px; }
  .df-hd { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 7px 12px; background: var(--term); border-bottom: 1px solid var(--line1); }
  .df-hd .p { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--fg); }
  .df-hd .s { flex: none; font-variant-numeric: tabular-nums; }
  .df-hd .a { color: var(--add); }
  .df-hd .d { color: var(--del); }
  .df-body { padding: 4px 0; font-size: 12px; line-height: 1.55; }
  .ln { padding: 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg2); }
  .ln.add { background: var(--add-bg); color: var(--fg); }
  .ln.del { background: var(--del-bg); color: var(--fg); }
  .ln.hunk { color: var(--fg3); }
  .df-more { padding: 6px 12px 8px; color: var(--fg3); }
  .ask-kv { margin: 0 4px; padding: 8px 12px; background: var(--term); border: 1px solid var(--line1); --r: 12px; display: grid; gap: 3px; max-height: min(220px, 30vh); overflow: auto; }
  .kv { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.5; }
  .kv .k { flex: none; color: var(--fg3); }
  .kv .v { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
  /* 多选：右边一个勾 */
  .mk { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 6px; box-shadow: inset 0 0 0 1.5px var(--fg4); color: transparent; transition: background-color var(--d-2), color var(--d-2), box-shadow var(--d-2); }
  .mk.on { background: var(--btn); color: var(--btn-fg); box-shadow: none; }
  .aopt[disabled] { cursor: default; }
  .ask-free { display: flex; align-items: center; gap: 6px; margin: 8px 0 2px; padding: 4px 4px 4px 12px; --r: 12px; background: var(--bg); border: 1px solid var(--line3); }
  .ask-free input { flex: 1; min-width: 0; height: 30px; border: 0; outline: 0; background: none; font: 13.5px var(--font); color: var(--fg); }
  .ask-free input::placeholder { color: var(--fg3); }
  .ask-err { display: flex; align-items: center; gap: 6px; margin: 8px 6px 0; font-size: 12.5px; color: var(--warn); }
  @container cx (max-width: 640px) {
    .ask-free input, .deny-box input { font-size: 16px; }
    .ask-diff, .ask-cmd .c { max-height: 28vh; }
  }
</style>
