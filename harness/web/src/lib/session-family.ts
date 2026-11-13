// 会话协作的前端纯逻辑（服务端 server/session-family.ts；不碰 DOM / Svelte，服务端测试可以直接 import）：
//  · parseSessionText：harness 片段里认出服务端拼的信封（格式与 bridge 的 web/src/lib/sessionFamily.svelte.js 相同）——
//      <session-message from name title relation [agent="claude"] [kind="brief"]>正文</session-message>   别的会话发来的话 / 父会话派的任务
//      <side-sessions-event> … <note from name title status [agent]>开头 400 字</note> … </side-sessions-event>   子会话汇报
//      <session-hint>…</session-hint>   只给模型看，界面上不显示
//  · nestSessions：侧栏一个项目里的会话按父子关系排好（子会话紧跟在父会话下面、缩进），dimensio 会话开出去的 Claude 子会话补一行
//  · toolSessionTarget：StartSession / SendMessage / ReadSession 的工具行要链到哪个会话
export type FamilyAgent = "dimensio" | "claude";

export interface FamilyLinkView {
  parent: string;
  parentTitle?: string;
  title: string;
  name: string;
  kind?: "fresh" | "fork";
  at?: number;
  agent?: "claude";
  parentAgent?: "claude";
  projectName?: string;
}
export interface FamilyState {
  links: Record<string, FamilyLinkView>;
  inbox: Record<string, number>;
  working: string[];
}

export type SessionPart =
  | { kind: "message"; from: string; agent: FamilyAgent; name: string; title: string; relation: string; brief: boolean; body: string }
  | { kind: "event"; notes: { from: string; agent: FamilyAgent; name: string; title: string; status: string; text: string }[] };

const ATTR_RE = /([\w-]+)="([^"]*)"/g;
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}
const agentOf = (v: string | undefined): FamilyAgent => (v === "claude" ? "claude" : "dimensio");

export function hasSessionEnvelope(text: string): boolean {
  return /<(session-message|side-sessions-event)\b/.test(text);
}

export function parseSessionText(text: string): { parts: SessionPart[]; rest: string } {
  const parts: SessionPart[] = [];
  if (!hasSessionEnvelope(text)) return { parts, rest: text };
  let rest = text.replace(/<session-hint>[\s\S]*?<\/session-hint>/g, "");
  rest = rest.replace(/<session-message\b([^>]*)>([\s\S]*?)<\/session-message>/g, (_, a: string, body: string) => {
    const x = attrs(a);
    parts.push({ kind: "message", from: x.from ?? "", agent: agentOf(x.agent), name: x.name ?? "", title: x.title ?? "", relation: x.relation || "linked", brief: x.kind === "brief", body: body.trim() });
    return "";
  });
  rest = rest.replace(/<side-sessions-event>([\s\S]*?)<\/side-sessions-event>/g, (_, inner: string) => {
    const notes: Extract<SessionPart, { kind: "event" }>["notes"] = [];
    for (const m of inner.matchAll(/<note\b([^>]*)>([\s\S]*?)<\/note>/g)) {
      const x = attrs(m[1]);
      notes.push({ from: x.from ?? "", agent: agentOf(x.agent), name: x.name ?? "", title: x.title ?? "", status: x.status || "done", text: m[2].trim() });
    }
    parts.push({ kind: "event", notes });
    return "";
  });
  return { parts, rest: rest.trim() };
}

// 任务说明里的「【背景】/【任务】」小标题拆成段落（父会话派任务时服务端这样拼；两边的 agent 同一格式）
export function briefSections(body: string): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const m of body.matchAll(/【(背景|任务)】\s*([\s\S]*?)(?=【(?:背景|任务)】|$)/g)) out.push({ label: m[1], text: m[2].trim() }); // i18n-ignore：与服务端拼的小标题匹配
  return out.length ? out : [{ label: "", text: body }];
}

// ── 侧栏：父子缩进 ───────────────────────────────────────────────────────────
export type NestedRow<T> =
  | { key: string; depth: number; s: T; foreign?: undefined }
  | { key: string; depth: number; s?: undefined; foreign: { id: string; agent: "claude"; title: string; working: boolean } };

// rows 是一个项目里的会话（已按侧栏顺序）；子会话跟在父会话下面（父会话不在这一组里的——开到别的项目、或父会话是 Claude 的——照常是顶层行）。
// 搜索过滤之后子会话命中、父会话没命中：子会话照旧顶层显示。
export function nestSessions<T extends { id: string }>(rows: T[], fam: FamilyState): NestedRow<T>[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, T[]>();
  const top: T[] = [];
  for (const r of rows) {
    const p = fam.links[r.id]?.parent;
    if (p && p !== r.id && ids.has(p)) (kids.get(p) ?? kids.set(p, []).get(p)!).push(r);
    else top.push(r);
  }
  // 父会话开出去的 Claude 子会话（不在 dimensio 的会话列表里）：补一行，点开去 Claude 页
  const claudeKids = new Map<string, { id: string; title: string; at: number }[]>();
  for (const [id, l] of Object.entries(fam.links)) {
    if (l.agent !== "claude" || !ids.has(l.parent)) continue;
    (claudeKids.get(l.parent) ?? claudeKids.set(l.parent, []).get(l.parent)!).push({ id, title: l.title, at: l.at ?? 0 });
  }
  const working = new Set(fam.working);
  const out: NestedRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (r: T, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ key: r.id, depth, s: r });
    // 子会话按派生先后（台账里的 at）排
    const ch = (kids.get(r.id) ?? []).slice().sort((a, b) => (fam.links[a.id]?.at ?? 0) - (fam.links[b.id]?.at ?? 0));
    for (const c of ch) walk(c, Math.min(depth + 1, 3));
    for (const c of (claudeKids.get(r.id) ?? []).sort((a, b) => a.at - b.at)) {
      out.push({ key: `claude:${c.id}`, depth: Math.min(depth + 1, 3), foreign: { id: c.id, agent: "claude", title: c.title, working: working.has(c.id) } });
    }
  };
  for (const r of top) walk(r, 0);
  for (const r of rows) if (!seen.has(r.id)) walk(r, 0); // 环（不该有）也别丢行
  return out;
}

// ── 工具行链到的会话 ──────────────────────────────────────────────────────────
const SESSION_TOOLS = new Set(["StartSession", "SendMessage", "ReadSession"]);
export function isSessionTool(name: string): boolean {
  return SESSION_TOOLS.has(name);
}

// StartSession：开出来的那个（family_link 事件 / 历史里 tool_result.meta.family）；SendMessage / ReadSession：参数 to
//（id、name、"parent"）按台账认。认不出来就不链。
export function toolSessionTarget(
  item: { name: string; args?: Record<string, unknown>; family?: { child?: string; target?: string; title?: string; agent?: string } },
  currentId: string | null,
  fam: FamilyState,
): { id: string; agent: FamilyAgent; title: string } | null {
  const linkTitle = (id: string) => fam.links[id]?.title || "";
  const agentFor = (id: string): FamilyAgent => {
    const l = fam.links[id];
    if (l?.agent === "claude") return "claude";
    if (!l && Object.values(fam.links).some((x) => x.parent === id && x.parentAgent === "claude")) return "claude";
    return "dimensio";
  };
  const hit = (id: string) => (id ? { id, agent: agentFor(id), title: linkTitle(id) || (item.family?.title ?? "") } : null);
  if (item.name === "StartSession") {
    const id = item.family?.child ?? "";
    return id ? { id, agent: item.family?.agent === "claude" ? "claude" : agentFor(id), title: item.family?.title || linkTitle(id) } : null;
  }
  if (!isSessionTool(item.name)) return null;
  if (item.family?.target) return hit(item.family.target);
  const to = String(item.args?.to ?? "").trim();
  if (!to) return null;
  if (to === "parent") return currentId ? hit(fam.links[currentId]?.parent ?? "") : null;
  if (fam.links[to] || Object.values(fam.links).some((l) => l.parent === to)) return hit(to);
  const byName = Object.entries(fam.links).find(([, l]) => l.name === to);
  if (byName) return hit(byName[0]);
  if (to.length >= 8) {
    const byPrefix = Object.keys(fam.links).find((id) => id.startsWith(to));
    if (byPrefix) return hit(byPrefix);
  }
  return null;
}
