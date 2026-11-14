// 会话里的媒体（页面截图、用户发的图片 / 文件附件）怎么打开。
//
// 嵌在 bridge 里：交给宿主（bridge 的统一查看器）——图片按本会话出现顺序成一个画廊、从点的那张开始翻，
// 下载 / 分享 / 复制图片 / 信息面板都在那边；宿主在 App 挂载时经 setMediaHost 登记（与 open-artifact.ts 同一模式）。
// 独立运行（8799 / dimensio 壳）没有宿主：图片退回应用自带的灯箱（app.lightbox），其它文件新标签页打开。
import { app, type Chat, type AttachmentItem, type Item } from "./state.svelte.ts";
import * as api from "./api.ts";
import { t } from "./i18n.ts";

export interface HostMediaItem {
  key: string; // 稳定身份（画廊里认「同一张」用）
  src: string; // 浏览器可直接加载的地址（令牌已镜像进查询串）
  name: string; // 文件名（下载名、标题）
  kind: "image" | "video" | "audio" | "file";
  caption?: string; // 图注（截图 = 页面地址）
}
export interface MediaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type MediaHost = (items: HostMediaItem[], index: number, rect: MediaRect | null) => void;

let host: MediaHost | null = null;
export function setMediaHost(fn: MediaHost | null): void {
  host = fn;
}

type ShotItem = Extract<Item, { kind: "screenshot" }>;

const baseName = (p: string) => p.replace(/\/$/, "").split("/").pop() || p;

function rectOf(el?: Element | null): MediaRect | null {
  const r = el?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
}

// 用户附件（.dimensio/uploads/… 等工作区内路径）：经 dock 文件接口按这个会话的工作区读；文件夹不能预览
export function attachmentMedia(chat: Chat, a: AttachmentItem): HostMediaItem | null {
  if (!a?.path || a.kind === "folder") return null;
  return {
    key: "att:" + a.path,
    src: api.dockFileUrl(chat.id ? { chatId: chat.id } : {}, a.path),
    name: baseName(a.path),
    kind: a.kind === "image" || a.kind === "video" || a.kind === "audio" ? a.kind : "file",
  };
}

// 页面截图：新事件只带会话资产 id（按 URL 取），老事件才是 dataUri
export function screenshotMedia(chat: Chat, it: ShotItem, src?: string): HostMediaItem | null {
  const url = src || it.dataUri || (it.asset && chat.id ? api.sessionAssetUrl(chat.id, it.asset) : "");
  if (!url) return null;
  let site = "";
  try {
    site = new URL(it.url).hostname;
  } catch {}
  return {
    key: "shot:" + (it.asset || it.url + ":" + url.length),
    src: url,
    name: t("页面截图") + (site ? " " + site : "") + ".png",
    kind: "image",
    caption: it.url,
  };
}

// 本会话所有图片（截图 + 用户发的图片附件），按时间线顺序；refs[i] 是对应的源对象（认「点的是哪一张」）
function sessionImages(chat: Chat): { items: HostMediaItem[]; refs: unknown[] } {
  const items: HostMediaItem[] = [];
  const refs: unknown[] = [];
  for (const it of chat.timeline) {
    if (it.kind === "screenshot") {
      const m = screenshotMedia(chat, it);
      if (m) {
        items.push(m);
        refs.push(it);
      }
    } else if (it.kind === "user" && it.attachments?.length) {
      for (const a of it.attachments) {
        if (a.kind !== "image") continue;
        const m = attachmentMedia(chat, a);
        if (m) {
          items.push(m);
          refs.push(a);
        }
      }
    }
  }
  return { items, refs };
}

// 打开一组媒体：有宿主交给宿主；没有就图片进灯箱、其它新标签页
export function openMedia(items: HostMediaItem[], index = 0, el?: Element | null): void {
  const list = items.filter(Boolean);
  if (!list.length) return;
  const i = Math.max(0, Math.min(index, list.length - 1));
  if (host) {
    host(list, i, rectOf(el));
    return;
  }
  const it = list[i];
  if (it.kind === "image") app.lightbox = { src: it.src, caption: it.caption ?? it.name };
  else window.open(it.src, "_blank", "noopener");
}

// 点了会话里的一张图（截图卡 / 附件缩略图）：进本会话画廊，定位到它；画廊里认不出（如还没进时间线）就单张打开。
// 非图片附件（pdf / 文档 / 音视频）单独打开。
export function openChatMedia(chat: Chat, source: ShotItem | AttachmentItem, el?: Element | null, src?: string): void {
  const single = "kind" in source && source.kind === "screenshot" ? screenshotMedia(chat, source as ShotItem, src) : attachmentMedia(chat, source as AttachmentItem);
  if (!single) return;
  if (single.kind !== "image") {
    openMedia([single], 0, el);
    return;
  }
  const { items, refs } = sessionImages(chat);
  let i = refs.indexOf(source);
  if (i < 0) i = items.findIndex((x) => x.key === single.key);
  if (i < 0) {
    openMedia([single], 0, el);
    return;
  }
  // 截图卡当前显示的可能是备用线路（隧道）地址：被点的这张用卡上真在显示的
  if (src) items[i] = { ...items[i], src };
  openMedia(items, i, el);
}
