<script lang="ts">
  // 本机模型控制面板（LocalAiChip 呼出）：顶上切引擎（Qwen 27B = llama.cpp / Strata 125B），状态 / 进程 / 端点 + 一键启停，
  // 下面是启动参数（Qwen：上下文 / KV 缓存精度 / 视觉 / MTP 投机解码 + 显存估算；Strata：上下文 / KV / 视觉 / KV 流式）。
  // 两台共用一张卡，起一台服务端会先停另一台。参数改的是草稿，点「保存」才落到服务端；
  // 服务在跑时按钮变「保存并重启」——不重启新参数不生效，目录里的上下文长度却已经变了，两边会对不上。
  // 开着时胶囊的轮询收紧到 2 秒。旧后端没有这组接口（404）：面板照样能开，状态写「状态不可用」、不出参数区。
  // 由 Composer 渲染在输入框卡片外面（Popover 自己也会挪到 .hxroot 下）。
  import { onMount } from "svelte";
  import {
    localAiApply,
    localAiStart,
    localAiStop,
    type LocalAiSettings,
    type LocalEngine,
    type LocalKv,
    type StrataKv,
    type StrataSettings,
  } from "../../lib/api.ts";
  import { actLocalAi, lai, localAiState, localAiStateText, refreshLocalAi, refreshLocalGpu, setLocalEngine, vramVerdict } from "../../lib/localai.svelte.ts";
  import { reloadMeta } from "../../lib/state.svelte.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import Button from "../ui/Button.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Switch from "../ui/Switch.svelte";
  import { t, tc, tr } from "../../lib/i18n.ts";

  let { anchor, onclose }: { anchor: HTMLElement; onclose: () => void } = $props();

  const phase = $derived(localAiState());
  const text = $derived(localAiStateText());

  const ENGINE_OPTS: { value: LocalEngine; label: string }[] = [
    { value: "qwen", label: "Qwen 27B" },
    { value: "strata", label: "Strata 125B" },
  ];
  const engine = $derived(lai.engine);
  const isStrata = $derived(engine === "strata");

  const CTX_OPTS = [
    { value: "32768", label: "32k" },
    { value: "65536", label: "64k" },
    { value: "131072", label: "128k" },
    { value: "196608", label: "192k" },
    { value: "262144", label: "256k" },
  ];
  const KV_OPTS: { value: LocalKv; label: string }[] = [
    { value: "q8_0", label: "q8" },
    { value: "q8q4", label: "K8 · V4" },
    { value: "q4_0", label: "q4" },
  ];
  const KV_HINT: Record<LocalKv, string> = {
    q8_0: t("8 位缓存，精度与不量化几乎无差别。"),
    q8q4: t("K 保 8 位（算注意力、怕压），V 降 4 位，折中。"),
    q4_0: t("4 位缓存，省一半显存；长文里的精确细节可能略差。"),
  };
  // 没有 32k：dimensio 第一轮的提示词 + max_tokens 就超了，Strata 直接拒（见 server/localai.ts）
  const STRATA_CTX_OPTS = [
    { value: "65536", label: "64k" },
    { value: "131072", label: "128k" },
    { value: "262144", label: "256k" },
  ];
  const STRATA_KV_OPTS: { value: StrataKv; label: string }[] = [
    { value: "int8", label: "int8" },
    { value: "k8v4", label: "K8 · V4" },
    { value: "q4_0", label: "q4" },
  ];
  const STRATA_KV_HINT: Record<StrataKv, string> = {
    int8: t("8 位缓存，精度与不量化几乎无差别。"),
    k8v4: t("K 保 8 位、V 降 4 位；这一档不支持 KV 流式，整份缓存留在显存。"),
    q4_0: t("4 位缓存，省一半；长文里的精确细节可能略差。"),
  };

  // 草稿：第一次拿到服务端的参数时落一份，之后用户改的是它；保存成功后跟着服务端走
  // 换引擎（lai.engine 变）时草稿作废，等新一台的状态回来再落；状态里的 engine 对不上也先不落（旧后端没有 engine = qwen）
  type Draft = LocalAiSettings | StrataSettings;
  let draft = $state<Draft | null>(null);
  let draftEngine = $state<LocalEngine>("qwen");
  $effect(() => {
    const st = lai.st;
    if (draft && draftEngine !== engine) draft = null;
    if (!draft && st?.settings && (st.engine ?? "qwen") === engine) {
      draft = { ...st.settings };
      draftEngine = engine;
    }
  });
  const saved = $derived(lai.st?.settings as Draft | undefined);
  const dirty = $derived.by(() => {
    if (!draft || !saved) return false;
    const a = draft as unknown as Record<string, unknown>;
    const b = saved as unknown as Record<string, unknown>;
    return Object.keys(a).some((k) => a[k] !== b[k]);
  });
  // 两种形状按引擎取：模板里直接点字段，省得到处判类型
  const qd = $derived(!isStrata && draft ? (draft as LocalAiSettings) : null);
  const sd = $derived(isStrata && draft ? (draft as StrataSettings) : null);
  const vram = $derived(qd ? vramVerdict(qd) : null);
  const gib = (mib: number) => (mib / 1024).toFixed(1);
  const kfmt = (n: number) => `${Math.round(n / 1024)}k`;

  // 在跑的实际值（/props）和已保存的对不上：多半是手工双击脚本起的，或改完还没重启
  const stale = $derived.by(() => {
    const r = lai.st?.running;
    if (!r || !saved || dirty) return "";
    const diff: string[] = [];
    if (r.ctx !== saved.ctx) diff.push(t("上下文 {ctx}", { ctx: kfmt(r.ctx) }));
    if (r.vision !== saved.vision) diff.push(r.vision ? t("视觉开") : t("视觉关"));
    return diff.length ? t("当前运行的是{diff}，重启后按设置生效。", { diff: diff.join(t("、")) }) : "";
  });
  // 溢出判据：共享内存（借来的系统内存）正常约 126 + 每 1k 上下文 2 MiB；多出 150 以上就是显存不够、在借内存
  const spilled = $derived.by(() => {
    const s = lai.gpu?.self;
    const r = lai.st?.running;
    // 判据是 Qwen 27B 的实测拟合；Strata 的 KV 流式本来就把缓存放在内存里，不套用
    return !isStrata && !!s && !!r && s.sharedMiB > 126 + (r.ctx / 1024) * 2 + 150;
  });

  async function save() {
    if (!draft) return;
    const d = { ...draft };
    const e = engine;
    await actLocalAi(() => localAiApply(d, e));
    if (!lai.err) {
      draft = lai.st?.settings ? { ...lai.st.settings } : d;
      void reloadMeta(); // 目录里本机型号的上下文 / 识图跟着变
      void refreshLocalGpu();
    }
  }

  // 进程状态变了（起来 / 停了）显存数字也跟着变，重拉一次
  $effect(() => {
    void phase;
    void engine;
    void refreshLocalGpu();
  });

  onMount(() => {
    lai.open = true;
    void refreshLocalAi();
    return () => {
      lai.open = false;
    };
  });
</script>

<!-- 宽度定死：随档位切换的说明文字长短不一，给范围的话弹层会跟着一跳一跳 -->
<Popover {anchor} {onclose} minWidth={320} maxWidth={320} role="dialog" label={t("本地 AI")}>
  <MenuLabel text={t("本地 AI · 本机")} />
  <div class="panel">
    <Segmented size="sm" full label={t("本机引擎")} options={ENGINE_OPTS} value={engine} onchange={(v) => setLocalEngine(v)} />
    <div class="kv">
      <span class="k">{t("状态")}</span>
      <span class="v" class:on={phase === "on"} class:hx-shimmer={phase === "starting"}>{text}</span>
    </div>
    {#if lai.st?.pid}
      <div class="kv"><span class="k">{t("进程")}</span><span class="v mono">PID {lai.st.pid}</span></div>
    {/if}
    {#if lai.st}
      <div class="kv"><span class="k">{t("端点")}</span><span class="v mono" title={lai.st.baseUrl}>{lai.st.baseUrl}</span></div>
    {/if}
    {#if lai.st?.process && lai.gpu?.self}
      <div class="kv">
        <span class="k">{t("显存")}</span>
        <span class="v mono" class:bad={spilled}>{gib(lai.gpu.self.dedicatedMiB)} GB{spilled ? t(" · 借用内存 {gb} GB", { gb: gib(lai.gpu.self.sharedMiB) }) : ""}</span>
      </div>
    {/if}
    {#if spilled}
      <p class="warn">{t("显存不够，已借用系统内存，生成速度会掉一半左右。调小上下文或换 q4 缓存。")}</p>
    {/if}
    {#if lai.err}
      <p class="err">{tr(lai.err)}</p>
    {/if}

    {#if lai.st && !lai.st.installed}
      <p class="hint">{t("这台机器上没有找到启动脚本，无法从这里控制。")}</p>
    {:else if lai.st?.missing?.length && !lai.st.process}
      <p class="warn">{t("模型还没就绪，缺这些文件：")}</p>
      <ul class="missing">
        {#each lai.st.missing as f (f)}<li class="mono" title={f}>{f}</li>{/each}
      </ul>
      <p class="hint">{isStrata ? t("在 Strata 目录运行 SETUP.bat，装 Qwen 的 IQ3_S（约 80 GB），装好后再从这里启动。") : t("补齐后再启动。")}</p>
    {:else if phase === "on"}
      <div class="act">
        <Button variant="danger" size="sm" full loading={lai.busy} onclick={() => actLocalAi(() => localAiStop(engine))}>
          {lai.busy ? t("处理中…") : t("停止本地 AI")}
        </Button>
      </div>
      <p class="hint">{isStrata ? t("停止后释放显存与约 50 GB 内存；下次使用需重新加载。") : t("停止后释放显存；下次使用需重新加载。")}</p>
    {:else}
      <div class="act">
        <Button variant="accent" size="sm" full loading={lai.busy || phase === "starting"} onclick={() => actLocalAi(() => localAiStart(engine))}>
          {lai.busy || phase === "starting" ? t("正在启动…") : t("启动本地 AI")}
        </Button>
      </div>
      <p class="hint">
        {isStrata
          ? t("125B MoE：专家常驻内存约 50 GB，加载需 1–3 分钟，就绪后圆点变绿。会先停掉 Qwen 27B。")
          : t("约 18GB 权重加载需 30–60 秒，就绪后圆点变绿。")}
      </p>
    {/if}
  </div>

  {#if draft && lai.st?.installed}
    <MenuLabel text={t("启动参数")} aside={dirty ? t("未保存") : undefined} />
    <div class="panel">
      {#if qd}
        <div class="field">
          <span class="k">{t("上下文")}</span>
          <Segmented size="sm" full label={t("上下文长度")} options={CTX_OPTS} value={String(qd.ctx)} onchange={(v) => (qd.ctx = Number(v))} />
        </div>
        <div class="field">
          <span class="k">{t("缓存精度")}</span>
          <Segmented size="sm" full label={t("KV 缓存精度")} options={KV_OPTS} value={qd.kv} onchange={(v) => (qd.kv = v)} />
          <p class="hint">{KV_HINT[qd.kv]}</p>
        </div>
        <div class="row">
          <div class="rt">
            <span class="rk">{t("视觉（识图）")}</span>
            <span class="hint">{t("挂载视觉模块，约 1.1 GB 显存")}</span>
          </div>
          <Switch label={t("视觉（识图）")} checked={qd.vision} onchange={(v) => (qd.vision = v)} />
        </div>
        <div class="row">
          <div class="rt">
            <span class="rk">{t("MTP 投机解码")}</span>
            <span class="hint">{t("约 2.2 GB 显存，生成快约 1.8 倍")}</span>
          </div>
          <Switch label={t("MTP 投机解码")} checked={qd.mtp} onchange={(v) => (qd.mtp = v)} />
        </div>
      {:else if sd}
        <div class="field">
          <span class="k">{t("上下文")}</span>
          <Segmented size="sm" full label={t("上下文长度")} options={STRATA_CTX_OPTS} value={String(sd.ctx)} onchange={(v) => (sd.ctx = Number(v))} />
        </div>
        <div class="field">
          <span class="k">{t("缓存精度")}</span>
          <Segmented size="sm" full label={t("KV 缓存精度")} options={STRATA_KV_OPTS} value={sd.kv} onchange={(v) => (sd.kv = v)} />
          <p class="hint">{STRATA_KV_HINT[sd.kv]}</p>
        </div>
        <div class="row">
          <div class="rt">
            <span class="rk">{t("KV 流式")}</span>
            <span class="hint">{t("64k 起把缓存放进内存，腾出显存多缓存专家，长上下文更快")}</span>
          </div>
          <Switch label={t("KV 流式")} checked={sd.stream} disabled={sd.kv === "k8v4"} onchange={(v) => (sd.stream = v)} />
        </div>
        <div class="row">
          <div class="rt">
            <span class="rk">{t("视觉（识图）")}</span>
            <span class="hint">{t("图片在显卡上编码，多占约 1 GB 显存")}</span>
          </div>
          <Switch label={t("视觉（识图）")} checked={sd.vision} onchange={(v) => (sd.vision = v)} />
        </div>
        <p class="hint">{t("MTP 投机解码是 Strata 常驻服务的必需项，始终开启。")}</p>
      {/if}

      {#if vram}
        <div class="vram">
          <div class="bar" role="meter" aria-label={t("预计显存占用")} aria-valuemin={0} aria-valuemax={vram.availMiB} aria-valuenow={vram.needMiB}>
            <span class="fill {vram.level}" style="width:{Math.min(100, (vram.needMiB / Math.max(1, vram.availMiB)) * 100)}%"></span>
          </div>
          <div class="kv small">
            <span class="k">{t("预计占用 约 {gb} GB", { gb: gib(vram.needMiB) })}</span>
            <span class="k">{t("可用 约 {gb} GB", { gb: gib(vram.availMiB) })}</span>
          </div>
          {#if vram.level === "over"}
            <p class="warn">{t("超出可用显存：能启动，但会借用系统内存，生成速度约减半。")}</p>
          {:else if vram.level === "tight"}
            <p class="hint">{t("余量很小，别的程序多占一点显存就可能溢出。")}</p>
          {/if}
        </div>
      {/if}

      {#if stale}
        <p class="hint">{stale}</p>
      {/if}
      {#if dirty}
        <div class="act two">
          <Button size="sm" disabled={lai.busy} onclick={() => saved && (draft = { ...saved })}>{tc("dimensio", "还原")}</Button>
          <Button variant="accent" size="sm" full loading={lai.busy} onclick={save}>
            {lai.st?.process ? t("保存并重启") : t("保存")}
          </Button>
        </div>
        {#if lai.st?.process}
          <p class="hint">
            {isStrata ? t("重启会中断正在进行的本机对话，并重新加载约 1–3 分钟。") : t("重启会中断正在进行的本机对话，并重新加载约 30–60 秒。")}
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</Popover>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 10px 10px;
  }
  .kv {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    font-size: var(--fs-md);
  }
  .kv.small {
    font-size: var(--fs-xs);
  }
  .k {
    flex: none;
    color: var(--text3);
  }
  .v {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  /* 「加载中」走全局微光（color: transparent + 背景裁字），给了字色就把它盖掉了 */
  .v:not(.hx-shimmer) {
    color: var(--text);
  }
  .v.on {
    color: var(--ok);
  }
  .v.bad {
    color: var(--warn);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-sm);
  }
  /* 五档上下文挤一行：收窄每档的内边距 */
  .field :global(.seg.sm button) {
    padding: 0 6px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .rt {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .rk {
    font-size: var(--fs-md);
    color: var(--text);
  }
  .vram {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 2px;
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--surface2);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--ok);
    transition:
      width var(--t-med) var(--ease),
      background-color var(--t-med) var(--ease);
  }
  .fill.tight {
    background: var(--warn);
  }
  .fill.over {
    background: var(--err);
  }
  .err {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .warn {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.55;
    color: color-mix(in srgb, var(--warn) 85%, var(--text));
  }
  .act {
    margin-top: 4px;
  }
  .act.two {
    display: flex;
    gap: 8px;
  }
  .missing {
    margin: 0;
    padding-left: 16px;
    font-size: var(--fs-xs);
    color: var(--text2);
  }
  .missing li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.55;
    color: var(--text3);
  }
</style>
