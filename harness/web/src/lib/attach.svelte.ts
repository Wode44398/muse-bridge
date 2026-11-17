// 粘贴 / 拖拽 → 附件的共用通路：与 AttachSheet「从设备上传」同一落点（保留目录结构；拖入的文件夹整体以
// <落点>/<dir>/ 一个 chip 表示）。
// U4（K08、#16）：落点从项目的 uploads/ 改到会话自己的附件目录 .dimensio/uploads/<会话 id 或草稿 id>/——不再进用户的
// 项目仓库（审阅面板、检查点、agent 的 git add 都看不到它），随会话删除回收；同名不覆盖（服务端加序号，chip 用它回的路径）。
import { app, toast, type Chat } from "./state.svelte.ts";
import { uploadFile } from "./api.ts";
import { haptic } from "./touch.ts";
import { t } from "./i18n.ts";
import { attachKind, previewable, type AttachKind } from "./attach-kind.ts";

export function uploadBase(chat: Chat): string {
  return `.dimensio/uploads/${chat.id ?? chat.draftId}`;
}

// 传一个文件到这个会话的附件目录，返回服务端实际落盘的路径
export function uploadToChat(chat: Chat, rel: string, file: File): Promise<string> {
  return uploadFile(`${uploadBase(chat)}/${rel}`, file, chat.id);
}

export type AttachEntry = { file: File; rel: string };

// 进行中的上传数（旧调用方看这个）；逐项的占位卡在 attachUp.items 里：每个散文件一张、拖进来的文件夹一张（done/total 计数），
// 带着发起它的会话（chat 键 = 会话 id 或草稿 id），输入框只画属于自己那一格会话的
export type PendingAttach = { id: number; chat: string; name: string; kind: AttachKind; url?: string; done: number; total: number };
export const attachUp = $state({ active: 0, items: [] as PendingAttach[] });
export const chatKey = (chat: Chat): string => String(chat.id ?? chat.draftId);

// 本机预览：这台设备上传的图片 / 视频留一份 blob 地址（按服务端落盘的路径记），输入框里的缩略图与预览直接用它——
// 不用等服务端、也不用管草稿会话还没有工作区作用域。宿主塞进来的附件（工作空间里拖进来的）没有，退回 dock 文件接口。
// size：文件大小（文件卡的副行）。最多留 80 份，多了先回收最早的。
export const attachLocal = $state<Record<string, { url?: string; size: number }>>({});
const localOrder: string[] = [];
function keepLocal(path: string, file: File, url?: string) {
  const old = attachLocal[path];
  if (old?.url && old.url !== url) URL.revokeObjectURL(old.url);
  attachLocal[path] = { url, size: file.size };
  localOrder.push(path);
  while (localOrder.length > 80) {
    const p = localOrder.shift()!;
    if (localOrder.includes(p)) continue;
    const v = attachLocal[p];
    if (v?.url) URL.revokeObjectURL(v.url);
    delete attachLocal[p];
  }
}
// 输入框里移除一个附件：它的本机预览也收回（已经发出去的那条消息走服务端地址，用不到它）
export function dropLocal(path: string) {
  const v = attachLocal[path];
  if (v?.url) URL.revokeObjectURL(v.url);
  delete attachLocal[path];
}
let pendSeq = 0;

const MAX_DROP = 300;

let pasteSeq = 0;

// 剪贴板截图在 Chrome 里统一叫 image.png，直接落盘会互相覆盖 → 换成时间戳名；
// 从资源管理器复制的真实文件保留原名。
function pasteName(f: File): string {
  if (f.name && !/^image\.\w+$/i.test(f.name)) return f.name;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const n = pasteSeq++;
  return `pasted-${stamp}${n ? `-${n}` : ""}.${ext}`;
}

export function pasteEntries(e: ClipboardEvent): AttachEntry[] {
  return [...(e.clipboardData?.files ?? [])].map((f) => ({ file: f, rel: pasteName(f) }));
}

// webkitGetAsEntry 只在 drop 事件的同步阶段有效 → 先一口气取完 entry 再异步遍历
export async function dropEntries(dt: DataTransfer): Promise<AttachEntry[]> {
  const out: AttachEntry[] = [];
  let truncated = false;
  const push = (file: File, rel: string) => {
    if (out.length >= MAX_DROP) {
      truncated = true;
      return;
    }
    out.push({ file, rel });
  };

  const roots: { entry: any; file: File | null }[] = [];
  for (const item of dt.items) {
    if (item.kind !== "file") continue;
    roots.push({ entry: (item as any).webkitGetAsEntry?.() ?? null, file: item.getAsFile() });
  }

  // readEntries 每次最多回 100 条，要循环读到空为止
  const readAll = (dir: any): Promise<any[]> =>
    new Promise((resolve) => {
      const reader = dir.createReader();
      const acc: any[] = [];
      const step = () =>
        reader.readEntries(
          (batch: any[]) => (batch.length ? (acc.push(...batch), step()) : resolve(acc)),
          () => resolve(acc),
        );
      step();
    });
  const fileOf = (en: any): Promise<File | null> =>
    new Promise((resolve) => en.file(resolve, () => resolve(null)));

  const walk = async (en: any, prefix: string): Promise<void> => {
    if (truncated) return;
    if (en.isFile) {
      const f = await fileOf(en);
      if (f) push(f, prefix + en.name);
    } else if (en.isDirectory) {
      for (const child of await readAll(en)) {
        await walk(child, prefix + en.name + "/");
        if (truncated) break;
      }
    }
  };

  for (const r of roots) {
    if (r.entry) await walk(r.entry, "");
    else if (r.file) push(r.file, r.file.name);
  }
  if (truncated) toast(t("文件过多，只取前 {n} 个", { n: MAX_DROP }));
  return out;
}

// chat：落到哪个会话（拖到分屏里哪一格的输入框就是那一格的；缺省 = 有焦点的那个）。上传途中切了会话也落回发起时的那个。
// 散文件逐个上传、传完一个就进输入框（占位卡原地换成真卡）；文件夹整个传完才以一张卡出现。
export async function uploadEntries(entries: AttachEntry[], chat: Chat = app.chat): Promise<void> {
  if (!entries.length) return;
  attachUp.active += entries.length;
  const key = chatKey(chat);
  const base = uploadBase(chat);
  // 占位卡：散文件一张一张（图片 / 视频先用本机 blob 画出缩略图），文件夹按顶层目录各一张
  const slot = new Map<string, PendingAttach>();
  for (const { file, rel } of entries) {
    const top = rel.includes("/") ? rel.split("/")[0] + "/" : rel;
    const got = slot.get(top);
    if (got) {
      got.total++;
      continue;
    }
    const kind = attachKind(top);
    const pv = kind === "folder" ? null : previewable(rel);
    const p: PendingAttach = { id: ++pendSeq, chat: key, name: top.replace(/\/$/, ""), kind, done: 0, total: 1, ...(pv ? { url: URL.createObjectURL(file) } : {}) };
    slot.set(top, p);
  }
  attachUp.items = [...attachUp.items, ...slot.values()];
  const live = (id: number) => attachUp.items.find((x) => x.id === id);
  const retire = (id: number) => (attachUp.items = attachUp.items.filter((x) => x.id !== id));
  let failed = 0;
  let any = false;
  for (const { file, rel } of entries) {
    const top = rel.includes("/") ? rel.split("/")[0] + "/" : rel;
    const p = slot.get(top)!;
    try {
      const saved = await uploadToChat(chat, rel, file);
      if (p.kind === "folder") {
        const cur = live(p.id);
        if (cur) cur.done++;
        if ((cur?.done ?? p.total) >= p.total) {
          retire(p.id);
          chat.attachments = [...new Set([...chat.attachments, `${base}/${top}`])];
          any = true;
        }
      } else {
        keepLocal(saved, file, p.url); // blob 交给本机预览接着用（占位卡退场不回收它）
        retire(p.id);
        chat.attachments = [...new Set([...chat.attachments, saved])];
        any = true;
      }
    } catch {
      failed++;
      if (p.kind !== "folder") {
        if (p.url) URL.revokeObjectURL(p.url);
        retire(p.id);
      } else {
        const cur = live(p.id);
        if (cur) cur.total--;
        if (cur && cur.done >= cur.total) {
          retire(p.id);
          if (cur.done) chat.attachments = [...new Set([...chat.attachments, `${base}/${top}`])];
        }
      }
    } finally {
      attachUp.active -= 1;
    }
  }
  if (any) haptic("light");
  if (failed) toast(t("{n} 个文件上传失败", { n: failed }));
}
