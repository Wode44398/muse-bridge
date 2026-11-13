// brands.mjs 的类型声明（brands.test.mjs 核对这里声明的导出名与运行时一致）。

export interface VendorEntry {
  /** 展示名；国内厂商用中文或中英混排（通义千问、智谱 GLM、Kimi、豆包、可灵…） */
  readonly name: string;
  /** lobehub 图标基名（-color 优先，单色品牌用单色版）；图标库没有的为 '' */
  readonly logo: string;
}

export interface VendorInfo extends VendorEntry {
  readonly key: string;
}

export const VENDORS: Readonly<Record<string, VendorEntry>>;
/** 型号 ID → 模型厂键；认不出返回 ''。收 models/、accounts/x/models/、publishers/google/models/、@cf/、us.anthropic.、:free、[1m] 等写法。 */
export function vendorOf(id: unknown): string;
/** 模型厂键（或别名 x-ai、moonshotai…）→ 展示信息；不认识返回 null。 */
export function vendorInfo(key: unknown): VendorInfo | null;

export type ProviderProtocol = "openai" | "anthropic" | "gemini";

export interface ProviderEntry {
  readonly key: string;
  readonly name: string;
  readonly logo: string;
  /** 对主机名与「主机名:端口」测 */
  readonly hosts: readonly RegExp[];
  /** 只写确定的推荐地址；要带账号 / 区域才能用的服务没有 */
  readonly baseUrl?: string;
  /** baseUrl 的协议 */
  readonly protocol?: ProviderProtocol;
  /** 添加页的快捷选择 */
  readonly featured?: boolean;
  /** 只出图 / 视频 / 音频的服务：认不出的型号算 other */
  readonly mediaOnly?: boolean;
}

export interface ProviderMatch {
  readonly key: string;
  readonly name: string;
  readonly logo: string;
  /** 按实际地址推的协议（路径带 /anthropic → anthropic）；原生接口（Vertex、Bedrock、纯媒体）没有 */
  readonly protocol?: ProviderProtocol;
  readonly mediaOnly?: boolean;
}

export type ProviderInfo = Omit<ProviderEntry, "hosts">;

export const PROVIDERS: readonly ProviderEntry[];
export const FEATURED_PROVIDERS: readonly ProviderEntry[];
/** 服务地址 → 提供商；认不出返回 null。不带 scheme 的主机名也收。 */
export function providerOf(baseUrl: unknown): ProviderMatch | null;
/** 提供商键（或仓库旧 id：mimo-plan、local、bailian…）→ 展示信息；不认识返回 null。 */
export function providerInfo(key: unknown): ProviderInfo | null;
