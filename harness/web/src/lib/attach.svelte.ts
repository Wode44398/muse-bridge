// 粘贴 / 拖拽 → 附件的共用通路：与 AttachSheet「从设备上传」同一落点（保留目录结构；拖入的文件夹整体以
// <落点>/<dir>/ 一个 chip 表示）。
// U4（K08、#16）：落点从项目的 uploads/ 改到会话自己的附件目录 .dimensio/uploads/<会话 id 或草稿 id>/——不再进用户的
// 项目仓库（审阅面板、检查点、agent 的 git add 都看不到它），随会话删除回收；同名不覆盖（服务端加序号，chip 用它回的路径）。
import { app, toast, type Chat } from "./state.svelte.ts";
import { uploadFile } from "./api.ts";
import { haptic } from "./touch.ts";
import { t } from "./i18n.ts";

export function uploadBase(chat: Chat): string {
  return `.dimensio/uploads/${chat.id ?? chat.draftId}`;
}

// 传一个文件到这个会话的附件目录，返回服务端实际落盘的路径
export function uploadToChat(chat: Chat, rel: string, file: File): Promise<string> {
  return uploadFile(`${uploadBase(chat)}/${rel}`, file, chat.id);
}

export type AttachEntry = { file: File; rel: string };

// 进行中的上传数（composer 用来显示"上传中"幽灵 chip）
export const attachUp = $state({ active: 0 });

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

export async function uploadEntries(entries: AttachEntry[]): Promise<void> {
  if (!entries.length) return;
  attachUp.active += entries.length;
  const added: string[] = [];
  const roots = new Set<string>();
  let failed = 0;
  const chat = app.chat; // 上传途中切了会话也落回发起时的那个
  const base = uploadBase(chat);
  for (const { file, rel } of entries) {
    try {
      const saved = await uploadToChat(chat, rel, file);
      if (rel.includes("/")) roots.add(`${base}/${rel.split("/")[0]}/`);
      else added.push(saved);
    } catch {
      failed++;
    } finally {
      attachUp.active -= 1;
    }
  }
  const paths = [...added, ...roots];
  if (paths.length) {
    chat.attachments = [...new Set([...chat.attachments, ...paths])];
    haptic("light");
  }
  if (failed) toast(t("{n} 个文件上传失败", { n: failed }));
}
