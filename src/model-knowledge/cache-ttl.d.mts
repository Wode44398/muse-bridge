// cache-ttl.mjs 的类型声明。

export interface CacheVendor {
  /** 分钟；null = 不提示（缓存放得很久 / 不知道） */
  readonly min: number | null;
  readonly note: string;
  readonly src: string;
  readonly models?: readonly { readonly re: RegExp; readonly min: number | null; readonly note: string }[];
}
export type CacheTtlSource = "user" | "request" | "host" | "family" | "default" | "local";
export interface CacheTtlInfo {
  /** 分钟；null = 没有会过期的缓存（不提示、不赶着压缩） */
  minutes: number | null;
  source: CacheTtlSource;
  vendor: string;
}
export interface CacheTtlOptions {
  /** 请求实际发到的上游主机或地址（别传本机网关） */
  host?: string;
  /** 用户在模型中心填的：0 = 不缓存 / 不提示，1–1440 分钟 */
  user?: unknown;
  /** 这次请求自己要的时长（分钟），如 Anthropic 官方端点发 ttl:"1h" 时给 60 */
  requestMinutes?: number;
}
export const CACHE_TTL_MAX: number;
export const CACHE_VENDORS: Readonly<Record<string, CacheVendor>>;
export function isLocalHost(host: unknown): boolean;
export function normalizeCacheTtl(v: unknown): number | undefined;
export function cacheTtl(id: unknown, opts?: CacheTtlOptions): CacheTtlInfo;
export function cacheTtlMs(id: unknown, opts?: CacheTtlOptions): number;
/** 界面用的一句说明（中文原文措辞键）；用户填的回 '' */
export function cacheTtlNote(id: unknown, opts?: CacheTtlOptions): string;
