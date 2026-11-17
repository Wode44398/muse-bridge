// 启动：拉服务端信息与配置、列表，接回在跑的会话，开全局事件通道。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { applyTheme } from "../theme.ts";
import { compat } from "../protocol.ts";
import { app, flags, toast } from "./core.svelte.ts";
import { startGlobalEvents } from "./global-events.ts";
import { refreshProjects, refreshSessions } from "./lists.ts";
import { resumeLiveStreams, resumeRunningSessions } from "./resync.ts";

// ── 启动 ─────────────────────────────────────────────────────────────────────
export async function boot() {
  flags.pageAway = false; // #93：每次进页 App 重挂、重走 boot
  applyTheme(app.appearance);
  // 重算而不是用模块加载时的快照：嵌入宿主的 configureApi 在组件实例化时才注入，
  // 模块加载先于它——appassets 壳（手机 apk）上快照恒 true，会把 bridge 分页
  // 误关进手动连接门（2026-08-05 两渠道 apk 实证）。
  app.needsSetup = api.needsSetup();
  if (app.needsSetup) {
    app.booted = true;
    app.sheet = "setup";
    return;
  }
  await api.initRoute(); // bridge 模式：先探学习过的 LAN，能直连就不走隧道
  await reloadMeta();
  app.booted = true;
  await Promise.all([
    app.features.sessions ? refreshSessions() : Promise.resolve(),
    app.features.projects ? refreshProjects() : Promise.resolve(),
  ]);
  // #93：离开页面时收掉的运行流接回来（列表刚刷新过，服务端此刻在跑哪些是准的）
  resumeLiveStreams();
  // 服务端还有会话在跑（本机被杀 / 别的设备发起）→ 全部接上直播（后台），
  // 上次看的那个若在其中则放前台。
  if (app.features.sessions) void resumeRunningSessions();
  if (app.features.sessions) startGlobalEvents();
}

let compatNoted = "";

export async function reloadMeta() {
  try {
    const [info, config] = await Promise.all([api.getInfo(), api.getConfig()]);
    // M10：服务端报了能力位就不再挨个探端点（只有 M10 之前的后端才探）
    const c = compat(info);
    const features = await api.detectFeatures(c.caps);
    app.info = info;
    app.config = config;
    app.features = features;
    app.compat = c;
    app.connError = "";
    // 不兼容就明说一次（Hero 上常驻一条；在会话里的人靠这条提示）
    const note = c.clientTooOld ? t("App 版本过旧，服务端已不再支持，请更新到最新版") : c.serverTooOld ? t("服务端版本较旧，部分功能可能用不了，请更新服务端") : "";
    if (note && note !== compatNoted) toast(note);
    compatNoted = note;
  } catch (e: any) {
    // 连不上：Hero 给入口提示（壳里点开连接设置，网页端提示检查服务）
    app.connError = tr(String(e?.message ?? e ?? t("连接失败")));
  }
}
