<script lang="ts">
  // 设置：API Key / 权限规则 / 工作空间 / 访问范围 / 外观 / 连接（安卓壳、带着连接的独立页）/ 诊断。
  // 型号、思考档与运行档位都在输入框旁就地选，这里不重复（档位是每轮可能动的东西，规则是配一次的东西）。
  //
  // 草稿是打开那一刻的快照（开着时别处改了配置不回灌）。配置还没到（连不上）时，依赖配置的几段先不出现，
  // 配置第一次到位时再填——以前这时候点保存，会拿空草稿把服务端的规则清掉。
  // permissionMode 不回写：它归输入框的档位胶囊管，设置页开着时用户随时可能切档，拿打开那一刻的快照写回去
  // 就是把人家的选择吃掉。allow 规则界面上不编辑，保存时照原样带回（保存那一刻现读）。
  // 外观切了就生效、只存本机（不进服务端，与「保存」无关）。
  // 记忆（K11）是一行入口：点进去是记忆面板的总览（‹ 回到这里）；行上一句话概括现状（打开设置时取一次总览）。
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    app,
    diagnosticsAvailable,
    exportDiagnostics,
    memoryOverviewAvailable,
    openMemory,
    reloadMeta,
    saveConfig,
    setAppearance,
    toast,
  } from "../../lib/state.svelte.ts";
  import { VENDORS, type Appearance } from "../../lib/theme.ts";
  import { activeRoute, fsMkdir, getConn, initRoute, isEmbedded, isShell, learnLan, memoryOverview, setConn } from "../../lib/api.ts";
  import { countLanes } from "./memory-viz.ts";
  import type { IconName } from "../../lib/icons.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, rise, smoothHeight } from "../../lib/motion.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Group from "../ui/Group.svelte";
  import Row from "../ui/Row.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import TextField from "../ui/TextField.svelte";
  import Button from "../ui/Button.svelte";
  import Chip from "../ui/Chip.svelte";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import Wordmark from "../brand/Wordmark.svelte";
  import Section from "./Section.svelte";
  import RuleList, { splitRules, toItems, type RuleItem } from "./RuleList.svelte";
  import DirBrowser, { joinPath } from "./DirBrowser.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const RULES_NOTE =
    "规则匹配命令/路径前缀，是减少误操作的软闸，不是对抗性安全沙箱。保存后对所有会话（包括正开着的）下一次调用就生效，重启也不丢。" +
    "权限卡上的「本会话都允许」只管当前会话，切了运行档位、访问范围或改了这里的规则就失效，会再问一次。" +
    "运行档位（自主执行 / 只读 / 先出计划）在输入框旁的档位胶囊，随时可切、对当前会话立刻生效。";
  const ACCESS_NOTE =
    "“仅工作空间”会拦截明显越界的路径与命令，用于防误操作，不提供对抗恶意命令的强隔离。" +
    "整机（默认）下 agent 可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。此设定是新会话的默认，重启也记得；" +
    "单个对话随时可在输入框的档位胶囊里切。";
  const ACCESS = [
    { value: "full", label: "整机可访问" },
    { value: "workspace", label: "仅工作空间" },
  ];
  const APPEARANCE: { value: Appearance; label: string; icon: IconName }[] = [
    { value: "auto", label: "跟随系统", icon: "laptop" },
    { value: "light", label: "浅色", icon: "sun" },
    { value: "dark", label: "深色", icon: "moon" },
  ];
  const ROUTE_NAME: Record<string, string> = { "same-origin": "同源", direct: "直连", tunnel: "隧道", lan: "局域网" };

  const vendor = $derived(VENDORS[app.config?.provider ?? "anthropic"] ?? VENDORS.anthropic);

  // ── 草稿：配置到位时填一次 ─────────────────────────────────────────────────────────
  let apiKey = $state("");
  let askRules = $state<RuleItem[]>([]);
  let denyRules = $state<RuleItem[]>([]);
  let askPending = $state("");
  let denyPending = $state("");
  let wsDraft = $state("");
  let access = $state("full");
  let seeded = $state(false);

  function seed(cfg: any) {
    askRules = toItems(cfg?.permissionRules?.ask);
    denyRules = toItems(cfg?.permissionRules?.deny);
    wsDraft = cfg?.workspace ?? "";
    access = cfg?.access ?? "full";
    seeded = true;
  }
  if (app.config) seed(app.config);
  $effect(() => {
    const cfg = app.config;
    if (cfg) untrack(() => !seeded && seed(cfg));
  });

  // 旧后端的配置里没有 workspace 字段：工作空间与访问范围整段不出现
  const hasWs = $derived(seeded && app.config?.workspace !== undefined);

  // ── 工作空间：选定只改草稿，「保存」才生效；新建文件夹是立刻建在服务端 ──────────────────────────
  let browsing = $state(false);
  let creating = $state(false);
  let newName = $state("");
  function toggleBrowse() {
    browsing = !browsing;
    creating = false;
    newName = "";
  }
  function pickHere(p: string) {
    if (!p) return;
    wsDraft = p;
    browsing = false;
    creating = false;
    haptic("light");
  }
  async function doMkdir(base: string, go: (p: string) => Promise<void>) {
    const name = newName.trim();
    if (!name) return;
    const target = joinPath(base, name);
    try {
      await fsMkdir(target);
      newName = "";
      creating = false;
      await go(target); // 建好直接进去
      haptic("light");
    } catch (e: any) {
      toast(`新建失败：${e?.message ?? e}`);
    }
  }
  const focusNow = (node: HTMLInputElement) => {
    requestAnimationFrame(() => node.focus());
  };
  // 触屏上行内小按钮放大一档（点按目标别太小）
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";
  const enterKey = (e: KeyboardEvent) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229;

  // ── 连接 ───────────────────────────────────────────────────────────────────────────
  // 只在安卓壳、或本来就接着一个连接的独立页出现（同源网页没有这一段；嵌进 bridge 时连接归宿主）。
  // 出不出现在打开时就定下（以前按输入框的值算，把地址清空的那一下整段就消失了）。
  const conn0 = getConn();
  const showConn = !isEmbedded() && (isShell() || Boolean(conn0?.url));
  let server = $state(conn0?.url ?? "");
  let token = $state(conn0?.token ?? "");
  let connMode = $state<string | null>(conn0?.mode ?? null); // 局域网重探按钮跟着保存后的连接走
  let connTick = $state(0); // getConn() 不是响应式的：换了连接手动拨一下
  let routeNow = $state(activeRoute());
  let probingLan = $state(false);
  const cleanUrl = () => server.trim().replace(/\/+$/, "");
  const connChanged = $derived.by(() => {
    void connTick;
    const c = getConn();
    return cleanUrl() !== (c?.url ?? "") || token.trim() !== (c?.token ?? "");
  });

  async function reprobe() {
    probingLan = true;
    haptic("light");
    try {
      await learnLan();
      await initRoute();
      routeNow = activeRoute();
    } finally {
      probingLan = false;
    }
    toast(routeNow === "lan" ? "已切局域网直连" : "局域网不可达，走隧道");
  }

  // ── 诊断（Q13）─────────────────────────────────────────────────────────────────────
  let exporting = $state(false);
  async function runExport() {
    exporting = true;
    haptic("light");
    try {
      await exportDiagnostics();
    } finally {
      exporting = false;
    }
  }

  // ── 保存 ───────────────────────────────────────────────────────────────────────────
  let saving = $state(false);
  let savedTick = $state(false);
  let tickTimer = 0;
  onDestroy(() => clearTimeout(tickTimer));
  // 配置没到时表单是空的：只有换了连接才有东西可存
  const canSave = $derived(seeded || connChanged);
  const texts = (items: RuleItem[]) => items.map((r) => r.text.trim()).filter(Boolean);

  function flushPending() {
    // 「添加规则」框里敲了没按添加的，也算进去（和以前的多行文本框一样，写了就存）
    if (askPending.trim()) askRules = [...askRules, ...toItems(splitRules(askPending))];
    if (denyPending.trim()) denyRules = [...denyRules, ...toItems(splitRules(denyPending))];
    askPending = "";
    denyPending = "";
  }
  function saved() {
    savedTick = true;
    haptic("light");
    clearTimeout(tickTimer);
    tickTimer = window.setTimeout(() => (savedTick = false), 1500);
  }

  async function save() {
    if (saving) return;
    saving = true;
    try {
      // 先换连接（换了服务端或令牌）：之后的配置写到新的服务端上
      const c = getConn();
      const u = cleanUrl();
      const t = token.trim();
      if (u !== (c?.url ?? "") || t !== (c?.token ?? "")) {
        if (!u) setConn(null);
        else if (t) setConn({ mode: "bridge", url: u, token: t });
        else setConn({ mode: "direct", url: u });
        connMode = getConn()?.mode ?? null;
        connTick++;
        await initRoute();
        await reloadMeta();
        routeNow = activeRoute();
      }
      if (!seeded) {
        // 表单是在配置到位之前打开的，草稿从没对上过服务端：这次只换连接，不拿空草稿去覆盖。
        // 配置这下到了就把表单填上，看过再改
        if (app.config) seed(app.config);
        saved();
        return;
      }
      flushPending();
      const patch: Record<string, unknown> = {
        permissionRules: {
          allow: app.config?.permissionRules?.allow ?? [],
          ask: texts(askRules),
          deny: texts(denyRules),
        },
      };
      if (apiKey.trim()) patch.apiKey = apiKey.trim();
      if (hasWs) {
        if (wsDraft && wsDraft !== app.config?.workspace) patch.workspace = wsDraft;
        if (access !== app.config?.access) patch.access = access;
      }
      await saveConfig(patch);
      apiKey = "";
      saved();
    } catch (e: any) {
      toast(`保存失败：${e?.message ?? e}`);
    } finally {
      saving = false;
    }
  }

  // ── 记忆（K11）：一行入口 + 一句话现状 ─────────────────────────────────────────────────
  const hasMemory = $derived(Boolean(app.compat?.caps?.includes("memory")));
  let memLine = $state<{ active: number; waiting: number; places: number } | null>(null);
  onMount(() => {
    if (!memoryOverviewAvailable()) return;
    memoryOverview()
      .then((ov) => {
        const c = countLanes(ov.buckets.flatMap((b) => b.items));
        memLine = { active: c.active, waiting: c.proposed + c.held, places: ov.buckets.length };
      })
      .catch(() => {}); // 取不到就不写现状，入口照样能点
  });
  const memSubtitle = $derived(
    !memLine
      ? "模型跨对话记住的事：看、确认、驳回、清理"
      : memLine.active || memLine.waiting
        ? `${memLine.active} 条生效${memLine.places > 1 ? `，分布在 ${memLine.places} 处` : ""}`
        : "还没有记忆",
  );
  // 草稿没存就走开会丢：先说一声（记忆面板是另一张面板，回来时设置按服务端现值重新填）
  const rulesOf = (items: RuleItem[]) => JSON.stringify(texts(items));
  const dirty = $derived(
    seeded &&
      (apiKey.trim() !== "" ||
        askPending.trim() !== "" ||
        denyPending.trim() !== "" ||
        rulesOf(askRules) !== JSON.stringify(app.config?.permissionRules?.ask ?? []) ||
        rulesOf(denyRules) !== JSON.stringify(app.config?.permissionRules?.deny ?? []) ||
        (hasWs && (wsDraft !== (app.config?.workspace ?? "") || access !== (app.config?.access ?? "full")))),
  );
  function goMemory() {
    if (dirty || connChanged) {
      toast("有改动还没保存：先点「保存」，再去看记忆");
      return;
    }
    haptic("light");
    openMemory({ fromSettings: true });
  }

  // ── 关于（安静的一行）──────────────────────────────────────────────────────────────
  const build = $derived((app.info?.build ?? null) as { codeSha?: string | null; dirty?: boolean | null } | null);
  const sha = $derived(build?.codeSha ? `${String(build.codeSha).slice(0, 7)}${build.dirty ? "*" : ""}` : "");
  const proto = $derived(app.compat?.server ?? 0);

  const mq = matchMedia("(min-width: 700px)");
  let wide = $state(mq.matches);
  $effect(() => {
    const on = (e: MediaQueryListEvent) => (wide = e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
</script>

<Sheet title="设置" {onclose} size="md">
  {#if seeded && app.config}
    <div in:rise={{ y: 8 }}>
      <Group>
        <Row title={vendor.name} subtitle="{vendor.company} · {app.config.model ?? ''}">
          {#snippet leading()}<VendorLogo skin={app.config?.provider ?? "anthropic"} size={30} />{/snippet}
          {#snippet trailing()}
            {#if app.config?.hasKey}
              <span class="tag">已配 Key</span>
            {:else}
              <span class="tag warn">缺 Key</span>
            {/if}
          {/snippet}
        </Row>
      </Group>

      <Section title="API Key" footnote="Key 只存于服务端内存，不落盘、不回传浏览器。">
        <TextField
          type="password"
          mono
          bind:value={apiKey}
          label="API Key"
          placeholder={app.config.hasKey ? "••••••••（留空保持不变）" : `粘贴 ${vendor.name} API Key`}
        />
      </Section>

      {#if hasMemory}
        <Group title="记忆">
          <Row icon="memory" title="记忆管理" subtitle={memSubtitle} chevron onclick={goMemory}>
            {#snippet trailing()}
              {#if memLine?.waiting}<span class="tag warn">{memLine.waiting} 条待处理</span>{/if}
            {/snippet}
          </Row>
        </Group>
      {/if}

      <RuleList
        title="每次问我（逐行，如 Bash(git push:*)）"
        label="添加「每次问我」规则"
        placeholder="添加规则，如 Bash(git push:*)"
        bind:items={askRules}
        bind:pending={askPending}
      />
      <RuleList
        title="从不允许"
        label="添加「从不允许」规则"
        placeholder="添加规则，如 Bash(rm -rf:*)"
        footnote={RULES_NOTE}
        bind:items={denyRules}
        bind:pending={denyPending}
      />

      {#if hasWs}
        <Group title="工作空间">
          <div>
            <div class="ws">
              <span class="ws-ic"><Icon name="folder" size={18} /></span>
              <span class="ws-path" title={wsDraft}><bdi>{wsDraft}</bdi></span>
              <Chip tone="soft" chevron open={browsing} onclick={toggleBrowse}>{browsing ? "收起" : "更改"}</Chip>
            </div>
            <!-- 目录是展开之后才取的：高度跟着内容平滑生长（取到之前、换目录时都不跳） -->
            <div use:smoothHeight>
              <div>
                {#if browsing}
                  <div class="browse" in:fade={{ duration: 180 }} out:fade={{ duration: 120 }}>
                    <DirBrowser start={wsDraft} emptyText="无子文件夹" listHeight="240px">
                      {#snippet footer({ path, go })}
                        <div class="ops">
                          {#if creating}
                            <input
                              class="newname"
                              bind:value={newName}
                              placeholder="新文件夹名"
                              aria-label="新文件夹名"
                              autocomplete="off"
                              autocapitalize="off"
                              spellcheck="false"
                              enterkeyhint="done"
                              use:focusNow
                              onkeydown={(e) => {
                                if (!enterKey(e)) return;
                                e.preventDefault();
                                void doMkdir(path, go);
                              }}
                            />
                            <Button size={btn} variant="secondary" disabled={!newName.trim()} onclick={() => doMkdir(path, go)}>建</Button>
                            <Button size={btn} variant="ghost" onclick={() => (creating = false)}>取消</Button>
                          {:else}
                            <Button size={btn} variant="ghost" icon="folderPlus" disabled={!path} onclick={() => (creating = true)}>新建文件夹</Button>
                            <Button size={btn} variant="accent" disabled={!path} onclick={() => pickHere(path)}>选定此文件夹</Button>
                          {/if}
                        </div>
                      {/snippet}
                    </DirBrowser>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </Group>

        <!-- 被锁定（多用户服务端的租户实例，恒仅工作空间）就不给开关 -->
        {#if !app.config?.accessLocked}
          <Section title="访问范围" footnote={ACCESS_NOTE}>
            <Segmented full label="访问范围" options={ACCESS} value={access} onchange={(v) => (access = v)} />
          </Section>
        {/if}
      {/if}
    </div>
  {:else}
    <Group>
      <Row danger={Boolean(app.connError)} title={app.connError ? "连不上服务器" : "正在连接…"} subtitle={app.connError || undefined}>
        {#snippet leading()}
          {#if app.connError}<Icon name="wifiOff" size={20} />{:else}<Mark size={20} live />{/if}
        {/snippet}
      </Row>
    </Group>
  {/if}

  <Section title="外观">
    <Segmented
      full
      label="外观"
      options={APPEARANCE}
      value={app.appearance}
      onchange={(a) => {
        haptic("light");
        setAppearance(a);
      }}
    />
  </Section>

  {#if showConn}
    <Section title="连接" footnote="直连填电脑地址；走 bridge 填隧道地址 + 令牌，在家自动切局域网。">
      {#snippet aside()}<span class="route">{ROUTE_NAME[routeNow] ?? routeNow}</span>{/snippet}
      <div class="stack">
        <TextField type="url" mono bind:value={server} label="服务器地址" placeholder="http://192.168.1.10:8799 或 bridge 地址" />
        <TextField type="password" mono bind:value={token} label="访问令牌" placeholder="访问令牌（走 bridge 时填）" />
        {#if connMode === "bridge"}
          <div>
            <Button size={btn} variant="secondary" icon="network" loading={probingLan} onclick={reprobe}>
              {probingLan ? "探测中…" : "重新探测局域网"}
            </Button>
          </div>
        {/if}
      </div>
    </Section>
  {/if}

  {#if diagnosticsAvailable() && app.chat.id}
    <Section
      title="诊断"
      footnote="卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。"
    >
      <Button variant="secondary" icon="download" loading={exporting} onclick={runExport}>
        {exporting ? "生成中…" : "导出当前对话的诊断包"}
      </Button>
    </Section>
  {/if}

  <footer class="about">
    <span class="wm"><Wordmark height={14} /></span>
    {#if app.info}
      <p class="meta" title="{app.info.shell} · {app.info.workspace}">{app.info.shell} · <bdi>{app.info.workspace}</bdi></p>
      {#if sha || proto}
        <p class="meta">
          {#if sha}服务端 {sha}{/if}{#if sha && proto}&nbsp;·&nbsp;{/if}{#if proto}协议 {proto}{/if}
        </p>
      {/if}
    {/if}
  </footer>

  {#snippet footer()}
    <Button variant="primary" size={wide ? "md" : "lg"} full={!wide} disabled={!canSave} loading={saving} onclick={save}>
      {saving ? "保存中…" : savedTick ? "已保存 ✓" : "保存"}
    </Button>
  {/snippet}
</Sheet>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 9px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text2);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    white-space: nowrap;
  }
  .tag.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 13%, transparent);
  }

  /* 工作空间：当前草稿一行 + 展开的目录导航（同一块分组面里） */
  .ws {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 50px;
    padding: 8px 8px 8px 14px;
  }
  .ws-ic {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .ws-path {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* 长路径先露尾巴（真正区分目录的那一截） */
    direction: rtl;
    text-align: left;
  }
  .browse {
    border-top: 1px solid var(--border);
  }
  .ops {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 8px 8px 12px;
    border-top: 1px solid var(--border);
  }
  .newname {
    flex: 1;
    min-width: 120px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    outline: 0;
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-md);
    box-shadow: inset 0 0 0 1px var(--border);
    transition: box-shadow var(--t-fast) var(--ease);
  }
  .newname:focus {
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .newname::placeholder {
    color: var(--text3);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .route {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 9px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text2);
    background: var(--surface2);
  }

  .about {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin: 30px 0 4px;
    text-align: center;
  }
  .wm {
    display: inline-flex;
    color: var(--text3);
    margin-bottom: 4px;
  }
  .meta {
    max-width: 100%;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
