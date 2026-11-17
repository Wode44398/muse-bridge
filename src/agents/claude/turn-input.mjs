// 送进 CLI 的输入：流式输入流、用户消息的正文拼装、原生图片块。

import { statSync, readFileSync } from 'node:fs';
import { deviceById } from '../../runtime/device-registry.mjs';
import { parseDeviceRef, deviceRefNote, isDeviceRef } from '../../runtime/device-refs.mjs';

// 原生图片块。此前图片只以【绝对路径】出现在提示词里，靠一句「图片也用 Read」推着模型
// 自己去读——多花一个来回，模型还可能干脆不读；而且图片落在 tool_result 里，长对话压缩
// 时比用户轮更早被摘掉。现在把字节直接挂到用户消息上，这一轮就看得见。
//
// 路径清单【照旧保留】：历史气泡里的缩略图是 routes/sessions.mjs 的 splitAttachments()
// 从那段文本反解出来的，拿掉就砸掉历史；何况有路径模型才能对文件本身做别的事。
const IMAGE_SIGS = [
  { mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
  { mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
// 按真实魔数判类型，不认扩展名——一个改名成 .png 的 jpeg 会让 API 直接 400。
const IMAGE_MAX_BYTES = 3_500_000;      // base64 后约 4.7MB，留在 Anthropic 单图 5MB 内
const IMAGE_MAX_COUNT = 8;
const IMAGE_MAX_TOTAL = 12_000_000;

function nativeImageBlocks(paths) {
  const blocks = [];
  let total = 0;
  for (const p of paths) {
    if (blocks.length >= IMAGE_MAX_COUNT || total >= IMAGE_MAX_TOTAL) break;
    let bytes;
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > IMAGE_MAX_BYTES) continue;   // 超限的仍走路径 + Read
      bytes = readFileSync(p);
    } catch { continue; }
    const sig = IMAGE_SIGS.find((s) => s.test(bytes));
    if (!sig) continue;
    total += bytes.length;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: sig.mime, data: bytes.toString('base64') } });
  }
  return blocks;
}

// 流式输入模式（2026-08-27 起恒走这条路，字符串单轮模式退役）。SDK 只在 prompt 是
// 【字符串】时把本次 query 当单轮（isSingleUserTurn），出 result 后自动 endInput() 关
// stdin——stdin 一关，CLI 进入收尾：权限通道（canUseTool 走同一条控制流）当场死掉
//（后台子 agent 的 Write 报 "Tool permission request failed: AbortError: Stream closed"），
// 后台任务在收尾宽限期后被杀、完成通知无人消费（08-27 快照会话「翻译干一半中断」事故）。
// AsyncIterable 输入 SDK 不会自动关 stdin，但【生成器一结束输入流就耗尽 = stdin EOF】，
// 效果等同（实验证实：后台任务在 result 后 5s 即被 stop）。所以 yield 完本轮消息后
// 挂在 gate 上不结束：输入流保持开启，CLI 活着、权限通道活着、后台任务完成时 CLI 会
// 注入 task-notification 自动续轮。收轮时机完全由读循环决定（release() + break →
// 迭代器 return() → SDK cleanup）。
// push()（09-28 挂起接力）：挂起等后台任务期间用户又发了一条——直接送进【同一个】活着的 CLI，
// 它立刻开一轮作答（result 的 user_message_uuids 带回这条的 uuid），后台任务照跑、完成照常续轮。
// 探针实测（SDK 0.3.280）：推第二条 5s 内出 result，后台 shell 存活到跑完并触发 task-notification 轮。
// deferFirst（新会话预热，见 parkSpare）：不先送第一条——CLI 照样起进程、做完初始化，停在等 stdin；
// 第一条消息由接管时的 push() 送进来。
export function makeTurnInput(text, blocks, deferFirst = false) {
  let release;
  let released = false;
  const gate = new Promise((r) => { release = r; });
  const queue = [];
  let wake = null;
  // priority（SDK 用户消息字段）：'next' = 插话——CLI 不等这一轮结束，做完手头这一步就读到它
  //（command_lifecycle 帧 queued → started → completed，result 的 user_message_uuids 带回 uuid）。
  const userMsg = (t, b, uuid, priority) => {
    const content = [];
    if (t) content.push({ type: 'text', text: t });
    content.push(...(b || []));
    return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, ...(uuid ? { uuid } : {}), ...(priority ? { priority } : {}) };
  };
  async function* stream() {
    if (!deferFirst) yield userMsg(text, blocks);
    // 保持输入流开启（见上）。release 前 CLI 不会因 stdin EOF 进入收尾；期间 push 的消息逐条送出。
    while (!released) {
      while (queue.length && !released) yield queue.shift();
      if (released) break;
      await Promise.race([gate, new Promise((w) => { wake = w; })]);
      wake = null;
    }
  }
  return {
    stream: stream(),
    release: () => { released = true; release(); if (wake) wake(); },
    push(t, b, uuid, priority) {
      if (released) return false;
      queue.push(userMsg(t, b, uuid, priority));
      if (wake) wake();
      return true;
    },
    // 撤回插话的第一道：还排在这里、没写进 CLI 的 stdin 就直接摘掉（CLI 根本没见过它）。
    withdraw(uuid) {
      const i = queue.findIndex((m) => m.uuid === uuid);
      if (i < 0) return false;
      queue.splice(i, 1);
      return true;
    },
  };
}

// 用户这条消息 → 送进 CLI 的正文 + 原生图片块（首轮开跑与挂起接力共用）。
export function composeTurnPrompt(message, attachments) {
  let prompt = message;
  if (attachments.length) {
    // 文件夹附件（前端「挂载文件夹」/ 工作空间发送目录）标注成目录并说清用法：
    // 整树已经在磁盘上了，要的是【按需读】——先 Glob/LS 摸结构，再挑着 Read，
    // 别一上来把每个文件都读一遍（大目录会直接烧穿上下文）。
    const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
    // 引用对话（侧栏把另一条会话拖进来，/api/session/quote 落的 <ts>-chatref-<id>-<标题>.md）同理标注：
    // 那是另一段对话的完整记录，是这条消息的背景，不是要处理的「文件」。
    const isQuote = (p) => /[\\/]\d+-chatref-[0-9a-fA-F-]{36}-[^\\/]*\.md$/.test(p);
    // 设备文件夹引用（device://，runtime/device-refs.mjs）：路径在用户电脑上、服务器上没有，
    // 只能经 mcp__device__files 按需读；标注里带设备 id，agent 照填 device 参数，不依赖会话连的是哪台。
    const lines = attachments.map((p) => {
      const r = parseDeviceRef(p);
      // 路径包反引号：「新建文件夹 (2)」这类以括号结尾的名字，裸写时模型会把括号当注释截掉（端到端实测）
      if (r) return `- \`${r.path}\`  ← ${deviceRefNote(deviceById(r.deviceId)?.name, r.deviceId)}`;
      return isDir(p) ? `- ${p}  ← 文件夹` : isQuote(p) ? `- ${p}  ← 引用的对话` : '- ' + p;
    });
    const local = attachments.filter((p) => !isDeviceRef(p));
    const anyDev = local.length < attachments.length;
    const anyDir = local.some(isDir);
    const anyQuote = local.some(isQuote);
    prompt += (message ? '\n\n' : '') +
      '[用户上传了以下附件，绝对路径如下。图片已经直接附在本条消息里、你现在就看得见，不必再 Read 它（只有需要看更多细节时才 Read）；其余文件请按需用 Read 工具读取'
      + (anyDir ? '；标注「文件夹」的是整个目录已挂载在这里：先用 Glob/Grep 摸清结构再挑需要的文件 Read，不要把里面所有文件都读一遍' : '')
      + (anyQuote ? '；标注「引用的对话」的是用户从另一段对话拖过来的完整记录（Markdown），先 Read 它了解那段对话的来龙去脉，再结合用户这条消息作答' : '')
      + (anyDev ? '；标注「用户电脑…上的文件夹」的【没有上传】，在用户自己的电脑上、服务器上不存在，Read/Glob/Grep/Bash 都碰不到它：一律用 mcp__device__files（path 就是反引号里的完整路径，device 参数照标注里的 device= 填），先 glob 或 list 摸清结构、grep 搜内容，再挑需要的文件 read（大文件用 offset/limit 按行分段），别把里面所有文件都读一遍；要在服务器上批量处理（跑脚本、大量改动）就先 pull 到工作目录再动手。设备离线或工具报错就如实告诉用户' : '')
      + ']\n' + lines.join('\n');
  }
  // 图片附件额外【原生】挂到用户消息上：这一轮就看得见，不必先花一个来回去 Read，
  // 而且它待在用户轮里，长对话压缩时不像 tool_result 那样先被摘掉。设备引用不在服务器上，跳过。
  const imageBlocks = attachments.length ? nativeImageBlocks(attachments.filter((p) => !isDeviceRef(p))) : [];
  return { prompt, imageBlocks };
}
