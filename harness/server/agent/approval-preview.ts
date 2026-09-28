// P11（ZCode C2）：审批载荷 = 执行事实——权限卡上摆这次要执行的东西（命令、diff、写入内容），按工具与参数现算，纯函数、
// 不碰 I/O。工具自己的 prepare() 给了更准的（Workflow 的脚本正文）就用它的，这里只是通用的回落。
// 长的截断并标 truncated：卡片不是看全文的地方，但看到的每个字都是真的会执行的。
import type { ApprovalPreview } from "../tools/types.ts";

// 单段文字最多这么多字符
export const PREVIEW_CAP = 4000;
// 写入内容只摆开头这么多行
const WRITE_HEAD_LINES = 40;

const str = (v: unknown) => (typeof v === "string" ? v : "");

function cap(text: string, max = PREVIEW_CAP): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

export function approvalPreview(toolName: string, args: Record<string, unknown>): ApprovalPreview | undefined {
  switch (toolName) {
    case "Bash": {
      const command = str(args.command);
      if (!command.trim()) return undefined;
      const c = cap(command);
      return { kind: "command", command: c.text, ...(args.background === true ? { background: true } : {}), ...(c.truncated ? { truncated: true } : {}) };
    }
    case "Edit": {
      const path = str(args.path);
      if (!path) return undefined;
      const oldS = cap(str(args.old_string));
      const newS = cap(str(args.new_string));
      return {
        kind: "diff",
        path,
        old: oldS.text,
        new: newS.text,
        ...(args.replace_all === true ? { replaceAll: true } : {}),
        ...(oldS.truncated || newS.truncated ? { truncated: true } : {}),
      };
    }
    case "Write": {
      const path = str(args.path);
      if (!path) return undefined;
      const content = str(args.content);
      const lines = content ? content.split("\n").length : 0;
      const headLines = content.split("\n").slice(0, WRITE_HEAD_LINES).join("\n");
      const head = cap(headLines);
      return {
        kind: "write",
        path,
        head: head.text,
        lines,
        bytes: Buffer.byteLength(content, "utf8"),
        ...(head.truncated || lines > WRITE_HEAD_LINES ? { truncated: true } : {}),
      };
    }
    case "Agent": {
      const prompt = str(args.prompt);
      if (!prompt.trim()) return undefined;
      const c = cap(prompt);
      return { kind: "text", text: c.text, ...(c.truncated ? { truncated: true } : {}) };
    }
    default:
      return undefined;
  }
}
