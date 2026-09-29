<script lang="ts">
  // 安卓独立壳首跑的连接门：整屏、关不掉（返回键交还系统，不进浮层栈），连上之后重新 boot。两种填法：
  //   · 直连：harness 所在电脑的地址（http://192.168.x.x:8799），令牌留空
  //   · bridge：隧道或局域网的 bridge 地址 + 访问令牌 → 出门走隧道、在家自动切局域网直连
  // 判定与文案逐字沿用旧版（探测只认 2xx 且回 JSON；401 / 403 各有说法）。
  import { learnLan, setConn, type Conn } from "../../lib/api.ts";
  import { app, boot } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, rise } from "../../lib/motion.ts";
  import TextField from "../ui/TextField.svelte";
  import Button from "../ui/Button.svelte";
  import Mark from "../brand/Mark.svelte";
  import { t, tr } from "../../lib/i18n.ts";

  let url = $state("");
  let token = $state("");
  let testing = $state(false);
  let error = $state("");
  let tokenEl: HTMLInputElement | undefined = $state();

  const probe = async (u: string, headers?: Record<string, string>) => {
    const res = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get("content-type") ?? "";
    return { ok: ct.includes("application/json"), status: res.status };
  };

  async function connect() {
    if (testing) return;
    const u = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(u)) {
      error = t("填完整地址，如 http://192.168.1.10:8799 或 bridge 隧道 https://…");
      return;
    }
    testing = true;
    error = "";
    haptic("light");
    try {
      const tok = token.trim();
      if (tok) {
        // bridge 通道
        const r = await probe(`${u}/api/harness/api/info`, { Authorization: `Bearer ${tok}` });
        if (!r.ok) {
          error = r.status === 401 ? t("令牌不对（bridge 401）") : r.status === 403 ? t("该账号无 harness 权限") : t("bridge 连不通（{status}）", { status: r.status });
          testing = false;
          return;
        }
        setConn({ mode: "bridge", url: u, token: tok } as Conn);
        void learnLan(); // 静默学习局域网直连
      } else {
        // 直连 harness
        const r = await probe(`${u}/api/info`);
        if (!r.ok) {
          // 也许填的是 bridge 地址但没给令牌
          if (r.status === 401) error = t("这像是 bridge 地址——请在下面填访问令牌");
          else error = r.status === 0 ? t("连不上（网络不通）") : t("连不上（HTTP {status}）", { status: r.status });
          testing = false;
          return;
        }
        setConn({ mode: "direct", url: u });
      }
      app.needsSetup = false;
      app.sheet = null;
      haptic("medium");
      await boot();
    } catch (e: any) {
      error = e?.name === "TimeoutError" ? t("连不上：超时") : t("连不上：{reason}", { reason: tr(String(e?.message ?? e)) });
    }
    testing = false;
  }

  const enterKey = (e: KeyboardEvent) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229;
</script>

<div class="gate" role="dialog" aria-modal="true" aria-label={t("连接 dimensio")} out:fade|global={{ duration: 220 }}>
  <div class="col">
    <div class="mark"><Mark size={76} intro /></div>
    <h1 in:rise|global={{ y: 10, delay: 380 }}>{t("连接 dimensio")}</h1>

    <div class="fields" in:rise|global={{ y: 10, delay: 480 }}>
      <TextField
        size="lg"
        type="url"
        mono
        bind:value={url}
        label={t("服务器地址")}
        placeholder={t("http://192.168.1.10:8799 或 bridge 地址")}
        enterkeyhint="next"
        onkeydown={(e) => {
          if (!enterKey(e)) return;
          e.preventDefault();
          tokenEl?.focus();
        }}
      />
      <TextField
        size="lg"
        type="password"
        mono
        bind:value={token}
        bind:el={tokenEl}
        label={t("访问令牌")}
        placeholder={t("访问令牌（走 bridge 时填）")}
        enterkeyhint="go"
        onkeydown={(e) => {
          if (!enterKey(e)) return;
          e.preventDefault();
          void connect();
        }}
      />
    </div>

    {#if error}
      <p class="err" role="alert" in:rise={{ y: 4 }}>{error}</p>
    {/if}

    <div class="go" in:rise|global={{ y: 10, delay: 560 }}>
      <Button variant="primary" size="lg" full loading={testing} onclick={connect}>{testing ? t("连接中…") : t("连接")}</Button>
    </div>
    <p class="tip" in:rise|global={{ y: 10, delay: 620 }}>{t("直连填电脑地址；走 bridge（出门可用）填隧道地址 + 令牌，在家会自动切局域网。")}</p>
  </div>
</div>

<style>
  .gate {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: calc(28px + var(--sat, 0px)) 24px calc(28px + var(--sab, 0px));
    background: var(--bg);
    color: var(--text);
  }
  .col {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: min(380px, 100%);
    /* 上下自动留白：内容比屏幕矮时居中（视觉重心略高），软键盘顶起来时可以滚 */
    margin: auto 0;
    padding-bottom: 4vh;
  }
  .mark {
    display: flex;
    justify-content: center;
    margin-bottom: 22px;
    color: var(--text);
  }
  h1 {
    margin: 0 0 26px;
    font-size: var(--fs-2xl);
    font-weight: 500;
    line-height: 1.25;
    letter-spacing: 0.01em;
    text-align: center;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .err {
    margin: 12px 4px 0;
    font-size: var(--fs-md);
    line-height: 1.55;
    color: var(--err);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .go {
    margin-top: 18px;
  }
  .tip {
    margin: 14px 8px 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
    text-align: center;
  }
</style>
