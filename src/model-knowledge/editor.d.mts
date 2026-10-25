// editor.mjs 的类型声明。
import type { Protocol, Source, ThinkingKind, Tier, TierValue } from "./knowledge.mjs";

export interface EditableModel {
  id: string;
  label?: string;
  enabled?: boolean;
  kind?: "chat" | "other";
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  thinking: ThinkingKind | string;
  efforts: Tier[];
  effortField?: string;
  effortDefault?: string;
  alwaysThinks?: boolean;
  source?: Partial<Record<string, Source | string>>;
}

export interface ProbeOutcome {
  error?: string;
  kind?: "chat" | "other";
  maxOutput?: number;
  vision?: boolean;
  thinksByDefault?: boolean;
  effortIds?: string[];
  tiers?: { id: string; ok: boolean }[];
}

export interface TierPreset {
  k: string;
  label: string;
  protocols?: Protocol[];
  set: { thinking: ThinkingKind; effortField: string; efforts: Tier[] };
}

export const THINK_MODES: readonly ThinkingKind[];
export function tierProblem(m: Partial<EditableModel> | null | undefined): { key: string; params: Record<string, unknown> } | null;
export const TIER_PRESETS: readonly TierPreset[];
export function presetsFor(protocol: string): TierPreset[];
export function modesFor(protocol: string): readonly ThinkingKind[];
export function fitsMode(val: TierValue | undefined, mode: string): boolean;
export function startTiers(mode: string, protocol: string, current?: Tier[]): Tier[];
export function fmtTierValue(v: TierValue | undefined): string;
export function parseTierValue(s: unknown): TierValue;
export function fmtTokens(n: number | null | undefined): string;
export const APPROX_SOURCES: readonly string[];
export const SOURCE_TEXT: Readonly<Record<string, string>>;
export function isApprox(m: { source?: Partial<Record<string, unknown>> } | null | undefined, k: string): boolean;
export const AUTO_THINK_SOURCES: readonly string[];
export function firstChat(models: { id: string; enabled?: boolean; kind?: string }[] | null | undefined): string;
export function pickCandidates(list: { id: string; kind?: string }[] | null | undefined): Record<string, boolean>;
export function capsBadges(m: Partial<EditableModel> | null | undefined): {
  other: boolean;
  ctx: string;
  ctxApprox: boolean;
  vision: boolean;
  visionApprox: boolean;
  think: "tiers" | "always" | "";
};
export function applyProbe<M extends EditableModel>(model: M, probe: ProbeOutcome | null | undefined): M;
export function wireModel<M extends EditableModel>(m: M): M;
export const DETECT_RESULT_TEXT: Readonly<Record<string, string>>;
export function isToggleName(name: unknown): boolean;
