// 全局配置写入，以及厂商、型号、思考深度、运行档位、访问范围、离开模式这些会话级设置。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { haptic } from "../touch.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, pulseGrid, toast } from "./core.svelte.ts";
import { reloadMeta } from "./boot.ts";
import { newChat } from "./pool.ts";

// ── 厂商 / 模型 / 配置 ───────────────────────────────────────────────────────
// 全局配置写入统一走这里：序号守卫防连续切换时的乱序覆盖（最后发起的赢）。
let cfgSeq = 0;
export async function patchGlobalConfig(patch: Record<string, unknown>) {
  const seq = ++cfgSeq;
  const cfg = await api.patchConfig(patch);
  if (seq === cfgSeq) app.config = cfg;
  return cfg;
}

// 页内切换：同家收起浮层即可；异家切 provider。已经开跑的会话（服务端能力位 "session-provider"）就在这条会话里换家——
// 聊过的内容接着用，在跑的这一轮照旧跑完、下一条消息起用新的（维护者 10-10：「一切换模型就开新对话了」）；
// 还没开跑的 / 老服务端，照旧切家 = 开新对话。成功打一发网格脉冲。
export async function switchVendor(provider: string) {
  if (provider === app.config?.provider) {
    app.vendorMenu = false;
    haptic("light");
    return;
  }
  haptic("medium");
  const chat = app.chat;
  if (chat.id && chat.cfg && sessionProviderAvailable()) {
    try {
      const r = await api.setSessionModel(chat.id, { provider });
      if (chat.cfg) chat.cfg = { ...chat.cfg, provider: r.provider ?? provider, model: r.model, thinking: r.thinking };
      app.vendorMenu = false;
      if (r.pending) toast(t("这一轮跑完后生效，下一条消息起用新的设置"));
    } catch (e: any) {
      toast(t("切换失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
      return;
    }
    // 全局跟上作新对话的默认（型号菜单读全局）；写失败不回滚会话
    try {
      const cfg = chat.cfg;
      await patchGlobalConfig(cfg ? { provider: cfg.provider, model: cfg.model, ...(cfg.thinking ? { thinking: cfg.thinking } : {}) } : { provider });
    } catch { /* 静默 */ }
    pulseGrid();
    return;
  }
  try {
    await patchGlobalConfig({ provider });
    newChat();
    app.vendorMenu = false;
    pulseGrid();
  } catch (e: any) {
    toast(t("切换失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}
function sessionProviderAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("session-provider"));
}
// 换厂商入口下面那行说明（型号菜单与模型服务浮层共用）。三种情形：
//  · 还没发过消息的新对话：什么都不会丢，这条新对话就从选的那家开始（以前这里落到「切换后开启新对话」，读着像要丢东西）；
//  · 已有的对话 + 服务端支持会话内换家：就在这条对话里换，聊过的接着用；
//  · 已有的对话 + 老服务端：照旧切家＝开新对话。
export function vendorSwitchNote(chat: Chat): string {
  if (!chat.id && !chat.running) return t("这条新对话就从它开始");
  if (chat.id && chat.cfg && sessionProviderAvailable()) {
    return chat.running ? t("这一轮跑完后换，对话接着用") : t("在当前对话里换，聊过的内容接着用");
  }
  return chat.running ? t("当前任务转入后台继续跑；切换后开启新对话") : t("切换后开启新对话，历史会话保留各自的服务归属");
}

// 型号 / 思考深度：先在本机上屏（菜单里的勾、思考深度的选中块当场挪过去），再写全局配置——以前要等服务端往返，
// 隧道上半秒多块才动（维护者 09-26：不跟手）。服务端会按型号的支持面收档，回来的配置为准；写失败退回并说一声。
// 与运行档位同一套语义：已经开跑的会话跑的是它自己的快照配置，只写全局等于没换（菜单勾着新型号、回答的还是旧的）——
// 所以先点名当前会话（服务端能力位 "session-model"），再写全局作新对话的默认。
export async function setModel(model: string) {
  await patchConfigOptimistic({ model }, (reason) => t("换型号没成功：{reason}", { reason }));
}
export async function setEffort(thinking: string) {
  await patchConfigOptimistic({ thinking }, (reason) => t("换思考深度没成功：{reason}", { reason }));
}
// fast mode：全局粘性开关（服务端每次请求现读，跑着的会话下一次请求就生效），不进会话快照，所以只写全局配置
export async function setFast(fast: boolean) {
  const prev = app.config;
  if (prev) app.config = { ...prev, fast };
  try {
    await patchGlobalConfig({ fast });
  } catch (e: any) {
    if (app.config?.fast === fast && prev) app.config = { ...app.config, fast: prev.fast };
    toast(t("切换 fast mode 没成功：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}
// 当前型号支不支持 fast（服务端 catalog 的 fast 标记；只有 Opus 5.5 / Opus 5 / Opus 4.8）
export function modelSupportsFast(provider: string | undefined, model: string | undefined): boolean {
  return modelsOf(provider ?? "").find((m) => m.id === model)?.fast === true;
}
function sessionModelAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("session-model"));
}
async function patchConfigOptimistic(patch: Record<string, string>, failed: (reason: string) => string) {
  const prev = app.config;
  if (prev) app.config = { ...prev, ...patch };
  // 退回全局的乐观值：这期间没有别的写入盖上来（还是我这一版）才退
  const revertGlobal = () => {
    const cur = app.config;
    if (prev && cur && Object.entries(patch).every(([k, v]) => cur[k] === v)) {
      app.config = { ...cur, ...Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]])) };
    }
  };
  const chat = app.chat;
  // 菜单列的是全局那家的型号；会话是别家的（不该出现：切前台时全局已对齐会话）就不点名，只改新对话的默认
  if (chat.id && chat.cfg && sessionModelAvailable() && (!prev || chat.cfg.provider === prev.provider)) {
    const prevChat = chat.cfg;
    chat.cfg = { ...chat.cfg, ...patch };
    try {
      const r = await api.setSessionModel(chat.id, patch);
      if (chat.cfg) chat.cfg = { ...chat.cfg, model: r.model, thinking: r.thinking };
      if (r.pending) toast(t("这一轮跑完后生效，下一条消息起用新的设置"));
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, model: prevChat.model, thinking: prevChat.thinking };
      revertGlobal();
      toast(failed(tr(String(e?.message ?? e))));
      return;
    }
    // 全局默认写失败不回滚会话：这条会话已经换成功了，全局只影响下一条新对话
    try {
      await patchGlobalConfig(patch);
    } catch { /* 静默 */ }
    return;
  }
  try {
    await patchGlobalConfig(patch);
  } catch (e: any) {
    revertGlobal();
    toast(failed(tr(String(e?.message ?? e))));
  }
}
// ── 运行档位（自主执行 / 只读 / 先出计划）──────────────────────────────────
// 读：前台会话的快照值优先。已开跑的会话跑的是它自己的 cfg（服务端如此），
// 全局值只是「下一条新对话」的默认，拿全局显示会在多会话间串档。
export type RunPermissionMode = "auto" | "read-only" | "plan" | "bypass";
export function permissionMode(chat: Chat = app.chat): RunPermissionMode {
  return (chat.cfg?.permissionMode ?? app.config?.permissionMode ?? "auto") as RunPermissionMode;
}

// 写：先点名当前会话（立刻生效，运行中也切得动——这正是「只读」这一档的用法：
// 给正在跑的 agent 拉手刹），再把全局值写成同一档作为新对话的默认。
export async function setPermissionMode(mode: RunPermissionMode) {
  if (mode === permissionMode()) return;
  const chat = app.chat;
  const prevChat = chat.cfg?.permissionMode;
  const prevGlobal = app.config?.permissionMode;
  // 乐观上屏；服务端随后广播的 mode 事件落到同一处，一致则无感
  if (chat.cfg) chat.cfg = { ...chat.cfg, permissionMode: mode };
  if (app.config) app.config = { ...app.config, permissionMode: mode };
  if (chat.id) {
    try {
      await api.setSessionMode(chat.id, mode);
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, permissionMode: prevChat };
      if (app.config) app.config = { ...app.config, permissionMode: prevGlobal };
      toast(t("切换档位失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
      return;
    }
  }
  // 全局默认写失败不回滚会话：这条会话已经切成功了，全局只影响下一条新对话。
  try {
    await patchGlobalConfig({ permissionMode: mode });
  } catch { /* 静默 */ }
}

// ── 访问范围（仅工作空间 / 整机）────────────────────────────────────────────
// 以前只住在设置页、且只对新会话生效——「让当前对话读一个工作空间外的文件」要
// 开设置→切→保存→再开新对话四步。现在与运行档位同一个菜单、同一套语义：
// 读=前台会话快照优先；写=先点名当前会话（服务端沙箱当场改判），再写全局默认。
export type AccessMode = "workspace" | "full";
// 默认整机（维护者 09-26）；仅工作空间是「有人拉了闸」
export function accessMode(chat: Chat = app.chat): AccessMode {
  return (chat.cfg?.access ?? app.config?.access ?? "full") as AccessMode;
}


// P13（X18）：本会话放行的工作区外只读目录（权限卡上「本会话都允许」记下的）；档位菜单里列着、能删
export function readRoots(chat: Chat = app.chat): string[] {
  return chat.readRoots;
}
export async function dropReadRoot(dir: string): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.revokeReadRoot(chat.id, dir);
    chat.readRoots = r.roots;
    if (chat.cfg) chat.cfg = { ...chat.cfg, readRoots: r.roots };
  } catch (e: any) {
    toast(t("没删成：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

export async function setAccessMode(access: AccessMode) {
  if (access === accessMode()) return;
  const chat = app.chat;
  const prevChat = chat.cfg?.access;
  const prevGlobal = app.config?.access;
  if (chat.cfg) chat.cfg = { ...chat.cfg, access };
  if (app.config) app.config = { ...app.config, access };
  if (chat.id) {
    try {
      await api.setSessionAccess(chat.id, access);
    } catch (e: any) {
      if (chat.cfg) chat.cfg = { ...chat.cfg, access: prevChat };
      if (app.config) app.config = { ...app.config, access: prevGlobal };
      toast(e?.status === 404 ? t("切换访问范围需要重启 harness 服务后可用") : t("切换访问范围失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
      return;
    }
  }
  try {
    await patchGlobalConfig({ access });
  } catch { /* 静默：会话已切成功，全局只影响下一条新对话 */ }
}

// ── P3：离开模式（会话级，与档位正交，默认关）────────────────────────────────
// 开着时：agent 的提问按合理默认继续并写明假设、需要批准的调用直接拒、计划留着等人回来——这一轮不会因为
// 没人点卡片而永久挂住。在这个会话发新消息 / 插话，服务端自动关（away 事件同步回来）。
export function awayMode(chat: Chat = app.chat): boolean {
  return chat.away;
}

export async function setAwayMode(on: boolean) {
  const chat = app.chat;
  if (!chat.id || chat.away === on) return;
  const prev = chat.away;
  chat.away = on;
  try {
    await api.setSessionAway(chat.id, on);
  } catch (e: any) {
    chat.away = prev;
    toast(e?.status === 404 ? t("离开模式需要重启 harness 服务后可用") : t("切换离开模式失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

export async function saveConfig(patch: Record<string, unknown>) {
  const cfg = await patchGlobalConfig(patch);
  await reloadMeta();
  return cfg;
}

// 当前 provider 的模型清单 / 当前模型支持的思考档（渲染直接用）
export function providerModels(): any[] {
  const cat = app.info?.catalog as any[] | undefined;
  return cat?.find((p) => p.id === app.config?.provider)?.models ?? [];
}
// 按 id 找型号：改名前的旧 id（目录条目的 aliases，如本机的 strata-orca → strata-flash-iq3s）也对得上，旧会话照样有档位 / 型号名
export function findModel(models: any[], id: string | undefined): any {
  if (!id) return undefined;
  return models.find((m) => m.id === id) ?? models.find((m) => Array.isArray(m.aliases) && m.aliases.includes(id));
}
export function modelEfforts(): string[] {
  const m = findModel(providerModels(), app.config?.model);
  return m?.efforts ?? ["off", "low", "high"];
}
export function modelsOf(providerId: string): any[] {
  const cat = app.info?.catalog as any[] | undefined;
  return cat?.find((p) => p.id === providerId)?.models ?? [];
}
