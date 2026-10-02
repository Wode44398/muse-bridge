// R12（K16 / N12，hermes 的图片阶梯退役）：历史图片以前每次请求都整张重发，直到被压缩掉——实际使用中一个会话每个请求带
// 50 MB 图片 base64、累计上传约 12.7 GB，全部经本机代理出站；切到 Anthropic 会直接撞 32 MB 的请求上限（413 不可重试，
// 会话报废）。两件事：
//   · 退役阶梯：一次请求里的图片（工具图 + 用户上传的）超过 provider 的额度（张数、base64 字节，目录里配）才动手，一次退一批
//     最老的工具图（每批 8 张，最近 3 张不动）；用户上传的只占额度、永不退役。退役标在转录的图片块上（retired），之后每次请求
//     的字节都一样——只在退役那一刻断一次缓存，不像「只留最近 N 张」那样每来一张新图就改写一次前缀。
//   · 入模前降采样：工具图（截图、Read 读的图、视频抽帧）长边超过 2000px 或体积过大就缩小再进转录；原图在工作区里，
//     Read 带 fullRes:true 可以要原图。
import type { Block } from "./turn.ts";

type Image = Extract<Block, { t: "image" }>;

export const DEFAULT_MEDIA_BUDGET = { maxImages: 20, maxBytes: 24_000_000 } as const;
export const RETIRE_BATCH = 8;
export const RETIRE_FLOOR = 3; // 最近这么多张工具图不退
export const MAX_EDGE = 2_000; // 入模图片的长边上限（px）
const KEEP_BYTES = 1_500_000; // 长边没超但文件超过这么大也重新编码

export interface MediaItem {
  block: Image;
  bytes: number; // base64 字节
  retirable: boolean; // 工具图 = true；用户上传的 = false
}

// 超额才退：按时间顺序从最老的工具图起，一次退一批，直到回到额度以内或没有可退的（最近 keepRecent 张不退，默认 RETIRE_FLOOR）。
export function planRetirement(
  items: readonly MediaItem[],
  budget: { maxImages: number; maxBytes: number; keepRecent?: number },
): Image[] {
  let count = items.length;
  let bytes = items.reduce((n, i) => n + i.bytes, 0);
  if (count <= budget.maxImages && bytes <= budget.maxBytes) return [];
  const tools = items.filter((i) => i.retirable);
  const pool = tools.slice(0, Math.max(0, tools.length - (budget.keepRecent ?? RETIRE_FLOOR)));
  const out: Image[] = [];
  while ((count > budget.maxImages || bytes > budget.maxBytes) && pool.length) {
    for (const i of pool.splice(0, RETIRE_BATCH)) {
      out.push(i.block);
      count--;
      bytes -= i.bytes;
    }
  }
  return out;
}

export function retiredText(name?: string): string {
  return `[image${name ? ` ${name}` : ""} retired to keep the request small — run the tool again or Read the file again if you need to see it]`;
}

// ── 入模前降采样 ─────────────────────────────────────────────────────────────
// sharp 装在仓库根的 node_modules（bridge 的依赖），它的 package.json exports 没挂类型——这里只声明用到的几个方法，
// 模块名走变量，免得 tsc 去解析它。
interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(o: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): SharpPipeline;
  clone(): SharpPipeline;
  png(): SharpPipeline;
  flatten(o: { background: string }): SharpPipeline;
  jpeg(o: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer) => SharpPipeline;
const SHARP_MODULE = "sharp";
let sharpLoad: Promise<Sharp | null> | null = null;
function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import(SHARP_MODULE).then(
    (m: { default?: Sharp }) => (m.default ?? (m as unknown as Sharp)),
    (e) => {
      console.error(`[media] sharp is not available, tool images go to the model unscaled: ${(e as Error).message}`);
      return null;
    },
  );
  return sharpLoad;
}

// 工具图进转录之前：长边超过 MAX_EDGE 或体积过大就缩小（不放大），PNG 缩完仍大就转 JPEG；fullRes 的原样放过。
// 解不开的图（格式不认、数据坏）原样放过——宁可多发，不丢。返回的块不再带 fullRes。
export async function downsampleForModel(block: Block): Promise<Block> {
  if (block.t !== "image") return block;
  const { fullRes, ...rest } = block;
  if (fullRes || !rest.data) return rest;
  const sharp = await loadSharp();
  if (!sharp) return rest;
  try {
    const input = Buffer.from(rest.data, "base64");
    const meta = await sharp(input).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h || (Math.max(w, h) <= MAX_EDGE && input.length <= KEEP_BYTES)) return rest;
    const resized = sharp(input).resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });
    let out = rest.mime === "image/png" ? await resized.clone().png().toBuffer() : null;
    let mime = "image/png";
    if (!out || out.length > KEEP_BYTES) {
      out = await resized.flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      mime = "image/jpeg";
    }
    return { ...rest, mime, data: out.toString("base64") };
  } catch {
    return rest;
  }
}
