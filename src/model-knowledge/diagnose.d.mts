// diagnose.mjs 的类型声明。

export type ProbeResult = "ok" | "model" | "auth" | "missing" | "error" | "network";

export interface DetectRow {
  protocol: string;
  baseUrl: string;
  authStyle?: string;
  result: ProbeResult;
}

export function vendorText(text: unknown): { json: boolean; msg: string };
export const PROBE_RANK: Readonly<Record<ProbeResult, number>>;
export function classifyProbe(status: number, text: unknown): Exclude<ProbeResult, "network">;
export function pickDetect<R extends DetectRow>(
  results: R[],
  draft: { protocol: string; baseUrl: string },
): { current: R | null; suggest: { protocol: string; baseUrl: string; authStyle?: string; result: ProbeResult } | null; ok: boolean };
export function parseLimit(text: unknown): number | null;
export function parseEffortList(text: unknown): string[] | null;
export function looksNotChat(status: number, text: unknown): boolean;
export function looksNoAudio(status: number, text: unknown): boolean;
export function mentionsModel(msg: unknown, model?: string): boolean;
export function protocolName(protocol: string): string;
export function endpointHint(protocol: string, baseUrl: string): string;
export const RED_PNG: string;
