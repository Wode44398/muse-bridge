// 把一次模型调用的流按产出顺序拼成 assistant 消息的内容块：正文、思考、工具调用交错排，思考逐块保留各自的签名。
// Anthropic 的交错思考要求带工具调用的回合原样回传每一块思考（各自的签名、原顺序）——拼成一块、只留最后一个签名、
// 挪到最前面，轻则丢推理连续性，重则验签失败。
// 块边界：provider 给了内容块下标时按下标切；没给时，签名封住当前块（之后的思考另起一块），中间夹了正文或工具调用也另起。
import type { Block } from "../turn.ts";
import { mergeDetail, type ReasoningDetail } from "../../providers/reasoning-details.ts";

type ThinkingBlock = Extract<Block, { t: "thinking" }>;
type ToolCallBlock = Extract<Block, { t: "tool_call" }>;

export interface ThinkingPiece {
  text: string;
  signature?: string;
  redacted?: string;
  index?: number;
  wire?: "reasoning_content";
  details?: ReasoningDetail[]; // OpenRouter reasoning_details 的分片：并进当前这一块（同一条的分片拼起来）
}

interface CallLike {
  id: string;
  name: string;
  args: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

// 流里工具调用的占位：记的是第几个调用（不是 id——上游可能给重复或空的 id，按 id 对会把调用合并、丢参数）
interface CallSlot {
  slot: number;
}

export class AssistantAssembler {
  private readonly seq: (Block | CallSlot)[] = [];
  private slots = 0;
  private open: { block: ThinkingBlock; index?: number; sealed: boolean } | null = null;

  text(s: string): void {
    if (!s) return;
    this.open = null;
    const last = this.seq[this.seq.length - 1];
    if (last && "t" in last && last.t === "text") last.text += s;
    else this.seq.push({ t: "text", text: s });
  }

  thinking(p: ThinkingPiece): void {
    if (p.redacted !== undefined) {
      // 加密的整块：自成一块，后面的思考另起
      this.seq.push({ t: "thinking", text: "", redacted: p.redacted });
      this.open = null;
      return;
    }
    if (!p.text && !p.signature && !p.details?.length) return;
    const o = this.open;
    const sameBlock = o && !o.sealed && (p.index === undefined || o.index === undefined || p.index === o.index);
    let block: ThinkingBlock;
    if (sameBlock) block = o!.block;
    else {
      block = { t: "thinking", text: "" };
      this.seq.push(block);
      this.open = { block, ...(p.index !== undefined ? { index: p.index } : {}), sealed: false };
    }
    if (p.text) block.text += p.text;
    if (p.wire) block.wire = p.wire;
    if (p.details?.length) for (const d of p.details) mergeDetail((block.details ??= []), d);
    if (p.signature) {
      block.signature = p.signature;
      this.open!.sealed = true;
    }
  }

  // 每个工具调用事件占一个位；第 n 个占位对应 build 时 calls 里的第 n 个（calls 与调用事件同序）
  call(): void {
    this.open = null;
    this.seq.push({ slot: this.slots++ });
  }

  // 工具调用的位置按流里的顺序，内容取最终的 calls（调用方可能已经改写过参数）；产出的 tool_call 块数恒等于 calls.length——
  // 多出来的占位丢掉，没占位的调用接在末尾。
  build(calls: readonly CallLike[]): Block[] {
    const out: Block[] = [];
    const toBlock = (c: CallLike): ToolCallBlock => ({ t: "tool_call", id: c.id, name: c.name, args: c.args, meta: c.meta });
    let used = 0;
    for (const b of this.seq) {
      if ("t" in b) out.push(b);
      else if (b.slot < calls.length) {
        out.push(toBlock(calls[b.slot]));
        used = Math.max(used, b.slot + 1);
      }
    }
    for (const c of calls.slice(used)) out.push(toBlock(c));
    return out;
  }
}
