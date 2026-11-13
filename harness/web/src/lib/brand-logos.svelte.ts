// 提供商 / 模型厂的品牌标：和 bridge 的模型中心用同一份表、同一份图——
//   · 认哪一家：src/model-knowledge/brands.mjs（按接口地址的主机名认提供商）；
//   · 图：bridge 的 web/src/lib/brandLogos.js（生成物，两百多 KB），第一次用到才加载，到了让用到的地方重画。
// 经 @hx 编进 bridge 时相对路径按真实文件位置解析，和 bridge 自己引的是同一个模块；开发态 vite 的 server.fs.allow 放开了这两处。
import { providerOf } from "../../../../src/model-knowledge/brands.mjs";

let lib = $state<Record<string, string> | null>(null);
let loading: Promise<void> | null = null;

/** 这枚标的 SVG（图库还没到 / 库里没有这个键 = 空串，调用方画首字兜底）。 */
export function brandSvg(key: string | undefined | null): string {
  if (!key) return "";
  if (!lib && !loading) {
    // @ts-ignore 生成物是纯 JS，没有类型声明
    loading = import("../../../../web/src/lib/brandLogos.js")
      .then((m: { BRAND_SVG?: Record<string, string> }) => {
        lib = m.BRAND_SVG ?? {};
      })
      .catch(() => {
        loading = null; // 下次用到再试
      });
  }
  return lib?.[key] ?? "";
}

/** 接口地址 / 主机名 → 品牌标的键（没收录 = 空串）。 */
export function brandLogoOf(hostOrUrl: string | undefined | null): string {
  if (!hostOrUrl) return "";
  try {
    return providerOf(hostOrUrl)?.logo ?? "";
  } catch {
    return "";
  }
}
