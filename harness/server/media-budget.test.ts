// R12（一）：历史图片的退役阶梯 + 工具图入模前降采样。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { downsampleForModel, fitImageBytes, parseImageByteLimit, planRetirement, type MediaItem } from "./agent/media-budget.ts";
import type { StreamEvent } from "./agent/events.ts";
import { randomBytes } from "node:crypto";
import type { Block, Msg } from "./agent/turn.ts";
import { providerMediaBudget } from "./catalog.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { readTool } from "./tools/read.ts";

type Image = Extract<Block, { t: "image" }>;
const img = (name: string, data = "AAAA"): Image => ({ t: "image", mime: "image/png", data, name });
const items = (n: number, retirable: boolean, bytes = 4, tag = retirable ? "tool" : "user"): MediaItem[] =>
  Array.from({ length: n }, (_, i) => ({ block: img(`${tag}${i}`), bytes, retirable }));
const names = (bs: Image[]) => bs.map((b) => b.name);

// sharp 在仓库根的 node_modules；exports 没挂类型，这里按用到的形状声明
interface SharpLike {
  (input?: Buffer | { create: { width: number; height: number; channels: 3; background: string } }): {
    png(): { toBuffer(): Promise<Buffer> };
    metadata(): Promise<{ width?: number; height?: number }>;
  };
}
const SHARP = "sharp";
const sharp = async (): Promise<SharpLike> => ((await import(SHARP)) as { default: SharpLike }).default;
async function png(width: number, height: number): Promise<Buffer> {
  return (await sharp())({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
}
async function dims(data: string): Promise<[number, number]> {
  const m = await (await sharp())(Buffer.from(data, "base64")).metadata();
  return [m.width ?? 0, m.height ?? 0];
}

test("MiMo 只让最近 2 张工具图入模（多了会把新截图认成旧图），用户上传的照旧不退", () => {
  const budget = providerMediaBudget("mimo");
  assert.deepEqual(budget, { maxImages: 2, maxBytes: 24_000_000, keepRecent: 2 });
  assert.deepEqual(planRetirement(items(2, true), budget), [], "两张以内不动");
  const eight = items(8, true);
  assert.deepEqual(names(planRetirement(eight, budget)), eight.slice(0, 6).map((i) => i.block.name), "8 张退到只剩最近 2 张");
  const mixed = [...items(2, false), ...items(3, true)];
  assert.deepEqual(names(planRetirement(mixed, budget)), ["tool0"], "用户上传的只占额度、不退；工具图保底最近 2 张");
  assert.equal(providerMediaBudget("kimi").keepRecent, undefined, "别家不受影响，仍按默认保底 3 张");
});

test("R12 退役阶梯：超额才退，一批 8 张、从最老的工具图起，最近 3 张不退；用户上传的只占额度、永不退", () => {
  const budget = { maxImages: 20, maxBytes: 1e9 };
  assert.deepEqual(planRetirement(items(20, true), budget), [], "没超额就一张不动");
  const thirty = items(30, true);
  assert.deepEqual(names(planRetirement(thirty, budget)), thirty.slice(0, 16).map((i) => i.block.name), "30 张：退两批（30 → 22 → 14）");

  const mixed = [...items(10, false), ...items(12, true)];
  assert.deepEqual(names(planRetirement(mixed, budget)), mixed.slice(10, 18).map((i) => i.block.name), "只退工具图，一批就回到额度以内");

  const mostlyUser = [...items(25, false), ...items(4, true)];
  assert.deepEqual(names(planRetirement(mostlyUser, budget)), ["tool0"], "工具图只剩最近 3 张可保底：退得动的退完就停，用户上传的不碰");

  const heavy = items(5, true, 10_000_000);
  assert.deepEqual(names(planRetirement(heavy, { maxImages: 20, maxBytes: 24_000_000 })), ["tool0", "tool1"], "按字节超额也退；最近 3 张不退");

  assert.equal(providerMediaBudget("anthropic").maxImages, 20);
  assert.ok(providerMediaBudget("gemini").maxBytes < 20_000_000, "Gemini 整个请求内联数据不能超过 20 MB");
});

test("R12 请求里的历史图超了额度：退一批最老的工具图——转录照留、发出去换成一句文字，之后每次请求字节都一样", async (t) => {
  // 能看图的模型（纯文本模型收到的历史图一律换成一句话，见 state.ts materializeMessages，轮不到额度）
  const { state } = loopState(t, scripted(t, { capabilities: { image: true } }), { memoryAudit: false });
  state.addUserMessageBlocks([{ t: "text", text: "看这两张" }, img("upload-a"), img("upload-b")], "看这两张");
  for (let i = 0; i < 30; i++) {
    state.appendUserBlocks([{ t: "text", text: "Attachment(s) from the previous tool call:" }, img(`shot${i}`)], false, { origin: "harness", kind: "tool-attachments" });
    state.messages.push({ role: "assistant", content: [{ t: "text", text: `saw shot${i}` }] });
  }
  const sent = (msgs: Msg[]) => msgs.flatMap((m) => m.content).filter((b) => b.t === "image").map((b) => (b as Image).name);
  const first = state.toTurn();
  assert.equal(sent(first.messages).length, 16, "32 张 → 退两批工具图（16 张）后 16 张");
  assert.deepEqual(sent(first.messages).slice(0, 2), ["upload-a", "upload-b"], "用户上传的原样在");
  assert.equal(JSON.stringify(first.messages).match(/retired to keep the request small/g)?.length, 16);
  assert.match(JSON.stringify(first.messages), /\[image shot0 retired/);
  const kept = state.messages.flatMap((m) => m.content).filter((b) => b.t === "image") as Image[];
  assert.equal(kept.length, 32, "转录里的图一张不少（界面照样能看）");
  assert.equal(kept.filter((b) => b.retired).length, 16);
  assert.equal(JSON.stringify(state.toTurn().messages), JSON.stringify(first.messages), "之后的请求字节一样，不再改写前缀");
});

test("会话中途换到纯文本模型：历史里的图发出去换成一句话（转录照留），不让请求 400", async (t) => {
  const { state } = loopState(t, scripted(t), { memoryAudit: false });
  state.addUserMessageBlocks([{ t: "text", text: "看这张" }, img("upload-a")], "看这张");
  const turn = state.toTurn();
  assert.equal(turn.messages.flatMap((m) => m.content).filter((b) => b.t === "image").length, 0);
  assert.match(JSON.stringify(turn.messages), /Image upload-a is not visible to .*takes no image input/);
  assert.equal(state.messages.flatMap((m) => m.content).filter((b) => b.t === "image").length, 1, "转录里的图还在（换回能看图的模型照样能看）");
});

test("R12 降采样：长边超过 2000px 的工具图缩到 2000，小图原样，fullRes 原样放过", async () => {
  const big = (await png(3_000, 1_200)).toString("base64");
  const scaled = await downsampleForModel({ t: "image", mime: "image/png", data: big, name: "big.png" });
  assert.equal(scaled.t, "image");
  assert.deepEqual(await dims((scaled as Image).data!), [2_000, 800]);
  assert.equal((scaled as Image).name, "big.png");

  const small = (await png(800, 600)).toString("base64");
  const same = await downsampleForModel({ t: "image", mime: "image/png", data: small });
  assert.equal((same as Image).data, small, "小图不重新编码");

  const full = await downsampleForModel({ t: "image", mime: "image/png", data: big, fullRes: true });
  assert.equal((full as Image).data, big);
  assert.equal("fullRes" in full, false, "进转录之前去掉 fullRes");

  const broken = await downsampleForModel({ t: "image", mime: "image/png", data: "bm90IGFuIGltYWdl" });
  assert.equal((broken as Image).data, "bm90IGFuIGltYWdl", "解不开的图原样放过");
});

test("R12 Read 读大图：进转录的是缩到 2000px 的；fullRes:true 进的是原图", async (t) => {
  for (const [fullRes, want] of [[false, [2_000, 800]], [true, [3_000, 1_200]]] as const) {
    const adapter = scripted(t, { capabilities: { image: true } }).next(useTool("r1", "Read", { path: "big.png", ...(fullRes ? { fullRes: true } : {}) }), say("done"));
    const { state, root } = loopState(t, adapter, { tools: [readTool], ctx: { agentSeesImages: true }, user: "看 big.png" });
    fs.writeFileSync(path.join(root, "big.png"), await png(3_000, 1_200));
    await drive(state, adapter);
    const image = state.messages.flatMap((m) => m.content).find((b) => b.t === "image") as Image | undefined;
    assert.ok(image?.data, "图进了转录");
    assert.deepEqual(await dims(image!.data!), [...want]);
    assert.equal("fullRes" in image!, false);
  }
});
// ── 单张图上限（2026-11-14 用户反馈：gpt-6-astra「rejects images larger than 1048576 bytes」，生图后 Read 回看的 1.37 MB 图
// 没被压——降采样只在超过 1.5 MB 时才动手——之后每次「接着做」都带着这张图被拒）──────────────────────────────────────
// 随机噪点图：PNG / JPEG 都压不小，逼出「降质量 → 缩尺寸」整条路
async function noisePng(width: number, height: number): Promise<Buffer> {
  const make = (await sharp()) as unknown as (input: Buffer, o: { raw: { width: number; height: number; channels: 3 } }) => { png(): { toBuffer(): Promise<Buffer> } };
  return make(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
}
const imagesIn = (msgs: Msg[]) => msgs.flatMap((m) => m.content).filter((b) => b.t === "image") as Image[];
const bytesOf = (b: Image) => Buffer.byteLength(b.data ?? "", "base64");

test("单张上限：GPT-6 系按型号表带 1 MiB 上限（经哪家接都一样），别家不带", () => {
  assert.equal(providerMediaBudget("openai", "gpt-6-astra").maxImageBytes, 1_048_576);
  assert.equal(providerMediaBudget("openai", "gpt-6.1-terra").maxImageBytes, 1_048_576);
  assert.equal(providerMediaBudget("anthropic", "claude-opus-5-5").maxImageBytes, undefined);
  assert.equal(providerMediaBudget("mimo").maxImageBytes, undefined);
});

test("单张上限：从报错里读出上限", () => {
  assert.equal(parseImageByteLimit(`{"error":{"message":"model \"gpt-6-astra\" rejects images larger than 1048576 bytes (got 1372413 bytes)"}}`), 1_048_576);
  assert.equal(parseImageByteLimit("image exceeds 5 MB maximum: 5300000 bytes > 5242880 bytes"), 5_242_880);
  assert.equal(parseImageByteLimit("Image too large, maximum 20MB"), 20_000_000);
  assert.equal(parseImageByteLimit("image is too large"), null);
});

test("单张上限：fitImageBytes 压到上限以内（先降质量、再缩尺寸）；downsampleForModel 带上限时连 fullRes 也压", async () => {
  const big = await noisePng(1_400, 1_000);
  assert.ok(big.length > 1_500_000, "噪点 PNG 足够大");
  const fitted = await fitImageBytes(big, 150_000);
  assert.ok(fitted && fitted.data.length <= 150_000, `压到 150 KB 以内（得到 ${fitted?.data.length}）`);
  assert.equal(fitted!.mime, "image/jpeg");
  assert.equal(await fitImageBytes(Buffer.from("not an image"), 1_000), null, "解不开的回 null");

  // 1.0–1.5 MB 之间的图以前原样放过：带上限就压
  const mid = await noisePng(700, 600);
  assert.ok(mid.length > 1_048_576 && mid.length < 1_500_000, `中等大小 ${mid.length}`);
  const data = mid.toString("base64");
  assert.equal((await downsampleForModel({ t: "image", mime: "image/png", data }) as Image).data, data, "不带上限照旧不动");
  const capped = await downsampleForModel({ t: "image", mime: "image/png", data }, 1_048_576) as Image;
  assert.ok(bytesOf(capped) <= 1_048_576);
  const full = await downsampleForModel({ t: "image", mime: "image/png", data, fullRes: true }, 1_048_576) as Image;
  assert.ok(bytesOf(full) <= 1_048_576, "fullRes 超了上限也压（原图根本发不出去）");
  assert.equal("fullRes" in full, false);
});

test("单张上限：发请求前把转录里超限的图压小、改写进转录（卡住的会话「接着做」能接着跑），之后请求字节不变", async (t) => {
  const mediaBudget = { maxImages: 20, maxBytes: 24_000_000, maxImageBytes: 200_000 };
  const adapter = scripted(t, { capabilities: { image: true, mediaBudget } }).next(say("看到了"));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  const big = (await noisePng(900, 700)).toString("base64");
  state.addUserMessageBlocks([{ t: "text", text: "看这张" }, { t: "image", mime: "image/png", data: big, name: "gen.png" }], "看这张");
  await drive(state, adapter);
  const [sent] = imagesIn(adapter.inputs[0].messages);
  assert.ok(sent && bytesOf(sent) <= 200_000, `发出去的图在上限以内（${sent && bytesOf(sent)}）`);
  assert.equal(sent.name, "gen.png");
  const [kept] = imagesIn(state.messages);
  assert.equal(kept.data, sent.data, "转录里改写成压过的那张");
  assert.equal(await state.fitImagesToLimit(), 0, "再来一次什么都不改");
});

test("单张上限：没登记过的模型报「图太大」→ 读出上限、压小、自动重发一次（不算重试，不报错）", async (t) => {
  const tooLarge: StreamEvent[] = [{
    e: "error", kind: "http_400", retriable: false, class: "image_too_large", compress: false, summary: "有张图超过了模型的单张上限",
    raw: `{"error":{"message":"model \"x\" rejects images larger than 300000 bytes (got 2100000 bytes)","type":"invalid_request_error"}}`,
  }];
  const adapter = scripted(t, { capabilities: { image: true } }).next(tooLarge, say("看到了"));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  const big = (await noisePng(900, 700)).toString("base64");
  state.addUserMessageBlocks([{ t: "text", text: "看这张" }, { t: "image", mime: "image/png", data: big }], "看这张");
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  assert.ok(!events.some((e) => e.e === "error"), "没报错");
  const [resent] = imagesIn(adapter.inputs[1].messages);
  assert.ok(bytesOf(resent) <= 300_000 * 0.74, `重发的图留了余量（${bytesOf(resent)}）`);
});

test("单张上限：压完还被拒就照常报错（每轮只压一次，不在循环里反复压）", async (t) => {
  const tooLarge: StreamEvent[] = [{ e: "error", kind: "http_400", retriable: false, class: "image_too_large", compress: false, summary: "图太大", raw: "image is too large" }];
  const adapter = scripted(t, { capabilities: { image: true } }).next(tooLarge, tooLarge);
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.addUserMessageBlocks([{ t: "text", text: "看这张" }, { t: "image", mime: "image/png", data: (await noisePng(900, 700)).toString("base64") }], "看这张");
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  const err = events.find((e) => e.e === "error") as { message: string } | undefined;
  assert.match(err?.message ?? "", /压小之后仍然被拒/);
});
