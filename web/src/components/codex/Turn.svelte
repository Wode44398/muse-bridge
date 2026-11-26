<script>
  // 一轮 = 你的话 + 工作记录 + 回答（视图模型见 lib/codex/turns.js）。
  // 顺序：你的话（附件在上）→ 工作记录 → 计划 → 这一轮画的图表 / 生成的媒体 → 回答 → 收尾的提醒、计划、改动卡、产物。
  // 图表和媒体不放进工作记录里：记录跑完会收成一行，它们得一直看得见。
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import WorkLog from './WorkLog.svelte';
  import PlanCard from './PlanCard.svelte';
  import Answer from './Answer.svelte';
  import TurnFoot from './TurnFoot.svelte';
  import WidgetFrame from '../claude/WidgetFrame.svelte';
  import ChatMediaImage from '../claude/ChatMediaImage.svelte';
  import ChatMediaVideo from '../claude/ChatMediaVideo.svelte';
  import ChatMediaAudio from '../claude/ChatMediaAudio.svelte';
  import { codexArtifactUrl, openPreview, kindOf } from '../../lib/preview.svelte.js';
  import { send, enqueue } from '../../lib/codex/store.svelte.js';
  import { isWidgetRow, mediaKindOf, mediaFromText, mediaPaths } from '../../lib/codex/thread/words.js';
  import { grow, riseInto } from '../../lib/codex/thread/fx.js';

  let { turn, sid = '', last = false, running = false, ask = null } = $props();

  let ball = $state(null);

  // 刚发出去的这一轮（不是打开旧线程、也不是重连接上的）：你的话从输入框升上来，记录随后长出来
  const fresh = untrack(() => turn.live && turn.startedAt && Date.now() - turn.startedAt < 2500);
  const rise = (node) => { if (fresh) riseInto(node); };
  const growLog = (node) => { if (fresh) setTimeout(() => grow(node), 120); };

  /* ---------------- 你的话 ---------------- */

  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const atts = $derived((turn.user?.attachments || []).filter((a) => a?.path).map((a) => {
    const name = String(a.name || baseName(a.path));
    const k = kindOf(name);
    return { ...a, name, kind: k === 'other' ? a.kind || 'other' : k };
  }));
  function openAtt(a) {
    const items = atts.map((x) => ({ origin: 'codex', id: sid, path: x.path, name: x.name, kind: x.kind, size: x.size, mime: x.mime }));
    openPreview(items, Math.max(0, atts.indexOf(a)));
  }

  /* ---------------- 图表与媒体 ---------------- */

  const outs = $derived.by(() => {
    const list = [];
    for (const r of turn.rows) {
      if (isWidgetRow(r)) {
        const failed = r.status === 'fail';
        list.push({
          type: 'widget', key: 'w:' + r.id,
          seg: {
            kind: 'widget', id: r.id, title: String(r.args.title || ''),
            loading: Array.isArray(r.args.loading_messages) ? r.args.loading_messages.map(String).slice(0, 4) : [],
            code: r.args.widget_code, status: failed ? 'error' : r.status === 'run' ? 'streaming' : 'ready',
            error: failed ? String(r.text || '').slice(0, 300) : '',
          },
        });
        continue;
      }
      const mk = mediaKindOf(r);
      if (mk) {
        const segs = mediaFromText(mk, r.text, r.args?.prompt || r.args?.text || '');
        for (const seg of segs) list.push({ type: 'media', key: 'm:' + seg.id, seg });
        // 认不出作品 id（写到了 outputPath 之类）：按回执里的文件路径从产物接口取
        if (!segs.length && r.status === 'ok') for (const p of mediaPaths(r.text)) list.push({ type: 'file', key: 'f:' + r.id + p, path: p });
        continue;
      }
      if (r.kind === 'image' && r.gen && r.path) list.push({ type: 'file', key: 'f:' + r.id, path: r.path });
    }
    return list;
  });

  // 图表里的按钮替你发话：跑着就排进「稍后发送」
  const widgetSend = (text) => (running ? enqueue(text) : send(text));

  const showLog = $derived(turn.live || turn.rows.length > 0 || !!turn.thinking || turn.status === 'stopped' || turn.status === 'error');
</script>

<div class="turn">
  {#if atts.length}
    <div class="u-atts">
      {#each atts as a}
        {#if a.kind === 'image'}
          <button class="u-img sq" onclick={() => openAtt(a)} title={a.name}><img src={codexArtifactUrl(sid, a.path, { name: a.name })} alt={a.name} loading="lazy" /></button>
        {:else}
          <button class="u-file sq" onclick={() => openAtt(a)} title={a.name}><Icon name="file" size={16} /><span>{a.name}</span></button>
        {/if}
      {/each}
    </div>
  {/if}
  {#if turn.user?.text}<div class="msg-user sq" use:rise>{turn.user.text}</div>{/if}

  {#if showLog}
    <div class="log-wrap" use:growLog><WorkLog {turn} {sid} {ask} bind:ball /></div>
  {/if}

  {#if turn.plan?.steps?.length}<PlanCard plan={turn.plan} live={turn.live} />{/if}

  {#each outs as o (o.key)}
    {#if o.type === 'widget'}
      <div class="t-widget">{#key o.seg.id}<WidgetFrame seg={o.seg} live={turn.live} sendPrompt={widgetSend} />{/key}</div>
    {:else if o.type === 'media'}
      <div class="t-media">
        {#key o.seg.id}
          {#if o.seg.mediaKind === 'image'}<ChatMediaImage id={o.seg.id} prompt={o.seg.prompt} ext={o.seg.ext || ''} />
          {:else if o.seg.mediaKind === 'video'}<ChatMediaVideo seg={o.seg} />
          {:else}<ChatMediaAudio seg={o.seg} />{/if}
        {/key}
      </div>
    {:else}
      {@const fk = kindOf(baseName(o.path))}
      {@const src = codexArtifactUrl(sid, o.path, { name: baseName(o.path) })}
      {#if fk === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="t-av sq" {src} controls preload="metadata"></video>
      {:else if fk === 'audio'}
        <audio class="t-aud" {src} controls preload="metadata"></audio>
      {:else}
        <button class="t-gen sq" onclick={() => openPreview({ origin: 'codex', id: sid, path: o.path, name: baseName(o.path), kind: 'image' })} title={o.path}>
          <img {src} alt="" loading="lazy" />
        </button>
      {/if}
    {/if}
  {/each}

  <Answer {turn} {sid} {ball} />
  <TurnFoot {turn} {sid} {last} {running} />
</div>

<style>
  .u-atts { align-self: flex-end; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; max-width: min(80%, 560px); margin-bottom: -4px; }
  .u-img { --r: 12px; overflow: hidden; border: 1px solid var(--line2); background: var(--fill1); }
  .u-img img { display: block; width: 72px; height: 72px; object-fit: cover; }
  .u-file { display: inline-flex; align-items: center; gap: 6px; height: 32px; max-width: 240px; padding: 0 10px; --r: 10px; background: var(--fill2); color: var(--fg2); font-size: 12.5px; transition: background-color var(--d-2); }
  .u-file:hover { background: var(--fill3); }
  .u-file span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-wrap { display: flex; flex-direction: column; }
  .t-widget { margin: 2px 0; }
  .t-media { align-self: flex-start; max-width: 100%; }
  .t-gen { align-self: flex-start; --r: 12px; overflow: hidden; border: 1px solid var(--line2); background: var(--fill1); }
  .t-gen img { display: block; max-width: min(100%, 360px); max-height: 320px; object-fit: contain; }
  .t-av { align-self: flex-start; display: block; --r: 12px; max-width: min(100%, 480px); max-height: 320px; background: var(--fill2); }
  .t-aud { align-self: flex-start; width: min(100%, 420px); }
</style>
