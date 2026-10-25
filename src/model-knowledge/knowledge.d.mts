// knowledge.mjs 的类型声明（harness 是 TS + strict：没有它，import 进来的全是 any；src/model-knowledge/exports.test.mjs
// 核对这里声明的导出名与运行时一致）。

export type Protocol = "anthropic" | "openai" | "gemini";
export type ThinkingKind = "none" | "budget" | "adaptive" | "effort";
export type Source = "api" | "table" | "probe" | "guess" | "default" | "user";
export type TierValue = string | number | boolean | Record<string, unknown> | null;

export interface Tier {
  id: string;
  name: string;
  value: TierValue;
}

export interface ThinkingShape {
  thinking: ThinkingKind;
  efforts: Tier[];
  effortField: string;
  effortDefault: string;
  alwaysThinks: boolean;
}

export interface ModelCaps extends ThinkingShape {
  kind: "chat" | "other";
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  video: boolean;
  audio: boolean;
  source: Partial<Record<"contextWindow" | "maxOutput" | "vision" | "thinking", Source>>;
}

export interface MediaBudget {
  maxImages?: number;
  maxBytes?: number;
  keepRecent?: number;
}

export interface TableEntry {
  re: RegExp;
  ctx?: number;
  out?: number;
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  think?: string;
  dflt?: string;
  media?: Readonly<MediaBudget>;
}

export interface ApiCaps {
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  kind?: "other";
  reasoning?: boolean;
  effortIds?: string[];
  alwaysThinks?: boolean;
}

export const PROTOCOLS: Protocol[];
export const TIER_ID_RE: RegExp;
export const MAX_TIERS: number;
export const OFF_TIER_IDS: readonly string[];
export const ON_TIER_IDS: readonly string[];
export function isOffTier(id: unknown): boolean;
export const NON_CHAT_RE: RegExp;
export const VISION_RE: RegExp;
export const LEVEL_NAMES: Readonly<Record<string, string>>;
export const BUDGET_SCALE: Readonly<Record<string, number>>;

export function bareModelId(id: unknown): string;
export function guessKind(id: unknown, apiType?: unknown): "chat" | "other";
export function thinkingTemplate(key: string, protocol: Protocol | string, opts?: { dflt?: string }): ThinkingShape | null;
export function tableEntry(id: unknown): TableEntry | null;
export function fromApi(x: unknown): ApiCaps;
export function parseModelList(j: unknown): unknown[] | null;
export function modelIdOf(x: unknown): string;
export function labelOf(x: unknown, id: string): string;
export function guessModel(
  id: string,
  opts?: { protocol?: Protocol | string; api?: unknown; defaults?: { contextWindow?: number; maxOutput?: number } | null },
): ModelCaps;

export function fixKnownBaseUrl(protocol: string, baseUrl: string): string;
export function siblingBaseUrls(baseUrl: string): string[];
export function anthropicUrl(base: string, sub: string): string;
export function openaiUrl(base: string, sub: string): string;
export function geminiUrl(base: string, model: string, stream?: boolean): string;
export function endpointUrl(protocol: string, base: string, model?: string): string;
export function modelsUrlCandidates(protocol: string, base: string): string[];
export function protocolMismatch(protocol: string, baseUrl: string): { to: Protocol; alt: string; sure: boolean } | null;

export function deepMerge<T extends Record<string, unknown>>(base: T, extra: unknown): T;
export function setPath<T extends Record<string, unknown>>(obj: T, path: string, value: unknown): T;
export function tierOf(model: { efforts?: Tier[] } | null | undefined, id: string): Tier | null;
export function defaultTierField(protocol: string): string;
export function writeTier<T extends Record<string, unknown>>(body: T, model: { effortField?: string }, tier: Tier | null, protocol: string): T;
export function applyTier<T extends Record<string, unknown>>(
  body: T,
  model: { thinking: ThinkingKind | string; efforts?: Tier[]; effortField?: string; maxOutput?: number },
  tierId: string,
  opts?: { protocol?: Protocol | string; cap?: number; baseBudget?: number },
): T;
