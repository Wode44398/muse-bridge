// U8（ZCode E4、kimi：审批面板与工具卡共用同一个 diff 渲染）：工具行展开后摆的执行事实——Edit 改前 / 改后、Write 写入内容的
// 开头、Bash 命令——交给与权限卡同一个 ApprovalPreview 组件渲染；别的工具照旧摆参数 JSON。与服务端 agent/approval-preview.ts
// 同一套取法（那边给权限卡用，这边从时间线里的 args 现算，历史会话也有）。
import type { ApprovalPreview } from "./timeline-types.ts";

const CAP = 4000;
const WRITE_HEAD_LINES = 40;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function cap(text: string): { text: string; truncated: boolean } {
  return text.length > CAP ? { text: text.slice(0, CAP), truncated: true } : { text, truncated: false };
}

export function toolPreview(name: string, args: unknown): ApprovalPreview | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "Bash": {
      const command = str(a.command);
      if (!command.trim()) return null;
      const c = cap(command);
      return { kind: "command", command: c.text, ...(a.background === true ? { background: true } : {}), ...(c.truncated ? { truncated: true } : {}) };
    }
    case "Edit": {
      const path = str(a.path);
      if (!path) return null;
      const o = cap(str(a.old_string));
      const n = cap(str(a.new_string));
      return { kind: "diff", path, old: o.text, new: n.text, ...(a.replace_all === true ? { replaceAll: true } : {}), ...(o.truncated || n.truncated ? { truncated: true } : {}) };
    }
    case "Write": {
      const path = str(a.path);
      if (!path) return null;
      const content = str(a.content);
      const lines = content ? content.split("\n").length : 0;
      const head = cap(content.split("\n").slice(0, WRITE_HEAD_LINES).join("\n"));
      return {
        kind: "write",
        path,
        head: head.text,
        lines,
        bytes: new TextEncoder().encode(content).length,
        ...(head.truncated || lines > WRITE_HEAD_LINES ? { truncated: true } : {}),
      };
    }
    default:
      return null;
  }
}
