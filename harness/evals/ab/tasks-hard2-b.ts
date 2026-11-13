// 模型档案 P0 第二批难题（b 组：编辑格式、工具调用与 Windows 环境）：现有题在各家都 95%+ 通过、没有区分度，这批专门拉开差距。
// 规则同 tasks-hard.ts：setup 摆现场、check 确定性判分（磁盘状态 + 自己跑测试 / 探针 + 会话记录里的工具调用）、reference 参考解；
// suite 写 "hard2"。每题都照真实工作里常见的错出：大文件里近似重复的上下文改错段、改生成物不改生成源、批量改名把 BOM / 换行改坏、
// 路径里的 $ ' & 在 shell 里被吃掉、超长输出只看了截断的头尾就下结论。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AbTask } from "./tasks.ts";
import { type CallRecord, callCommand, callPath, exists, filesUnder, nodeTests, pkgJson, probe, read, readJson, sha, toolCalls, write } from "./task-kit.ts";

const MIN = 60_000;
const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// 对象按键名排序后再比（JSON 对象的键序无意义：{ code, http, en, zh } 与 { code, http, zh, en } 算同一条）；数组顺序照旧要一致
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)]))
      : v;
const eqObj = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const importUrl = (dir: string, rel: string) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
const readBuf = (dir: string, rel: string): Buffer | null => {
  try {
    return fs.readFileSync(path.join(dir, rel));
  } catch {
    return null;
  }
};
const runNode = (dir: string, args: string[]) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: 60_000, env, maxBuffer: 64 * 1024 * 1024 });
};

// ── h2b-big-multi：近 4000 行的处理函数文件，三个版本段（v1 冻结 / v2 / admin）里同名函数各一份，改 6 处 ─────────────

const HB_RES = [
  "user", "userGroup", "userProfile", "userSession", "team", "teamMember", "project", "task", "order", "orderItem",
  "orderDraft", "orderNote", "invoice", "invoiceLine", "invoiceDraft", "payment", "refund", "product", "productVariant", "cart",
  "cartItem", "shipment", "ticket", "webhook", "plan",
];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const plural = (s: string) => (s.endsWith("y") ? `${s.slice(0, -1)}ies` : `${s}s`);
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
type HbSection = "v1" | "v2" | "admin";
const HB_SECTIONS: HbSection[] = ["v1", "v2", "admin"];

function hbBlocks(sec: HbSection, res: string): { name: string; text: string }[] {
  const P = cap(res);
  const route = `/${sec === "v1" ? "" : `${sec}/`}${kebab(plural(res))}`;
  const adm = sec === "admin" ? ["    requireAdmin(ctx);"] : [];
  const by = sec === "v1" ? "" : sec === "v2" ? ", { by: ctx.user.id }" : ", { admin: true }";
  const act = (verb: string) => (sec === "admin" ? `admin.${res}.${verb}` : `${res}.${verb}`);
  const meta = sec === "v1" ? "" : sec === "v2" ? ", { v: 2 }" : ", { v: 2, admin: true }";
  const ok = (v: string) => (sec === "v1" ? `reply(200, ${v})` : `reply(200, { data: ${v} })`);
  const check =
    sec === "v1"
      ? [`    const input = parse(req.body, "${res}");`, "    if (!input.ok) return reply(400, { error: input.error });"]
      : (strict: boolean) => [`    const input = validate("${res}", req.body, { strict: ${strict} });`, "    if (input.errors.length) return reply(400, { errors: input.errors });"];
  const inputLines = (strict: boolean) => (Array.isArray(check) ? check : check(strict));
  // 已知的复制粘贴错：v1 与 admin 的 archiveUser 审计动作写成了 delete（v1 冻结不修，admin 要修）
  const archiveVerb = res === "user" && sec !== "v2" ? "delete" : "archive";
  const fn = (doc: string, sig: string, body: string[]) => ({ name: sig, text: [`  /** ${sec} ${doc} */`, `  ${sig}(req, ctx) {`, ...body, "  },"].join("\n") });
  return [
    fn(`POST ${route}`, `create${P}`, [
      ...adm,
      ...inputLines(true),
      `    const rec = ctx.db.${res}.insert(input.value${by});`,
      `    ctx.audit("${act("create")}", rec.id${meta});`,
      `    return ${ok("rec")};`,
    ]),
    fn(`GET ${route}/:id`, `get${P}`, [
      ...adm,
      `    const rec = ctx.db.${res}.find(req.params.id${by});`,
      '    if (!rec) return reply(404, { error: "not_found" });',
      `    return ${ok("rec")};`,
    ]),
    fn(`GET ${route}`, `list${cap(plural(res))}`, [
      ...adm,
      "    const limit = Math.min(Number(req.query.limit ?? 50), 200);",
      sec === "v1"
        ? `    const rows = ctx.db.${res}.list({ limit, cursor: req.query.cursor });`
        : `    const page = ctx.db.${res}.list({ limit, cursor: req.query.cursor }${by});`,
      sec === "v1" ? "    return reply(200, { items: rows, limit });" : "    return reply(200, { data: page.rows, next: page.next });",
    ]),
    fn(`PUT ${route}/:id`, `update${P}`, [
      ...adm,
      ...inputLines(false),
      `    const rec = ctx.db.${res}.update(req.params.id, input.value${by});`,
      '    if (!rec) return reply(404, { error: "not_found" });',
      `    ctx.audit("${act("update")}", rec.id${meta});`,
      `    return ${ok("rec")};`,
    ]),
    fn(`DELETE ${route}/:id`, `delete${P}`, [
      ...adm,
      `    const done = ctx.db.${res}.remove(req.params.id${by});`,
      '    if (!done) return reply(404, { error: "not_found" });',
      `    ctx.audit("${act("delete")}", req.params.id${meta});`,
      "    return reply(204, null);",
    ]),
    fn(`POST ${route}/:id/archive`, `archive${P}`, [
      ...adm,
      `    const rec = ctx.db.${res}.update(req.params.id, { archived: true }${by});`,
      '    if (!rec) return reply(404, { error: "not_found" });',
      `    ctx.audit("${act(archiveVerb)}", rec.id${meta});`,
      `    return ${ok("rec")};`,
    ]),
  ];
}

const HB_HEAD = [
  "// 接口处理函数。三段：v1（已冻结，只修安全问题）、v2（现行）、admin（后台）。每个处理函数返回 { status, body }。",
  "// 路由表在 src/routes.js，按「段.函数名」引用这里的导出。",
  "",
  "export function reply(status, body) {",
  "  return { status, body };",
  "}",
  "",
  "// v1 的老式校验：{ ok, error, value }",
  "export function parse(body, kind) {",
  '  const bad = !body || typeof body !== "object" || body.invalid === true;',
  '  return { ok: !bad, error: bad ? `${kind}: invalid body` : null, value: body };',
  "}",
  "",
  "// v2 / admin 的校验：{ errors, value }",
  "export function validate(kind, body, opts = {}) {",
  "  const errors = [];",
  '  if (!body || typeof body !== "object") errors.push(`${kind}: body must be an object`);',
  "  else if (body.invalid === true) errors.push(`${kind}: invalid`);",
  '  else if (opts.strict && "id" in body) errors.push(`${kind}: id is read-only`);',
  "  return { errors, value: body };",
  "}",
  "",
  "export function requireAdmin(ctx) {",
  '  if (ctx.user?.role !== "admin") {',
  '    const e = new Error("forbidden");',
  "    e.status = 403;",
  "    throw e;",
  "  }",
  "}",
  "",
].join("\n");

function hbSource(mutate?: (sec: HbSection, name: string, text: string) => string): string {
  const parts = [HB_HEAD];
  for (const sec of HB_SECTIONS) {
    const title = sec === "v1" ? "API v1（已冻结：只修安全问题，别的一律不动）" : sec === "v2" ? "API v2（现行）" : "admin 后台接口（都要管理员）";
    parts.push(`// ===== ${title} =====`, `export const ${sec} = {`);
    const blocks = HB_RES.flatMap((r) => hbBlocks(sec, r)).map((b) => (mutate ? mutate(sec, b.name, b.text) : b.text));
    parts.push(blocks.join("\n\n"), "};", "");
  }
  return parts.join("\n");
}
const HB_ORIG = hbSource();
// 逐项验行为的 7 个函数（v1.deleteInvoice 是「v1 只修安全问题」的那个例外）；v2 其余 list* 只许改默认页大小，按文本比
const HB_TARGETS = ["v2.createOrder", "v2.listOrderItems", "v2.updateUserProfile", "admin.archiveUser", "v2.deleteInvoice", "v1.deleteInvoice", "v2.getOrderDraft"];
const HB_V2_LISTS = HB_RES.map((r) => `v2.list${cap(plural(r))}`).filter((k) => k !== "v2.listOrderItems");
const hbList25 = (text: string) => text.replace("req.query.limit ?? 50", "req.query.limit ?? 25");
function hbReference(): string {
  return hbSource((sec, name, text) => {
    const key = `${sec}.${name}`;
    if (key === "v2.createOrder") return text.replace("return reply(200, { data: rec });", "return reply(201, { data: rec });");
    if (key === "v2.listOrderItems") return text.replace("req.query.limit ?? 50", "req.query.limit ?? 20");
    if (HB_V2_LISTS.includes(key)) return hbList25(text);
    if (key === "v2.updateUserProfile") return text.replace("return reply(400, { errors", "return reply(422, { errors");
    if (key === "admin.archiveUser") return text.replace('"admin.user.delete"', '"admin.user.archive"');
    if (key === "v2.deleteInvoice" || key === "v1.deleteInvoice")
      return text.replace("  deleteInvoice(req, ctx) {\n", '  deleteInvoice(req, ctx) {\n    if (ctx.user?.role !== "admin") return reply(403, { error: "forbidden" });\n');
    if (key === "v2.getOrderDraft") return text.replace("if (!rec) return", "if (!rec || rec.deletedAt) return");
    return text;
  });
}

// 把文件切成「段.函数名 → 文本块（含上面那行 /** */）」与块外的骨架；切不开（结构被破坏）就返回 null
function hbParse(text: string): { blocks: Map<string, string>; skeleton: string } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = new Map<string, string>();
  const skel: string[] = [];
  let sec = "";
  for (let i = 0; i < lines.length; i++) {
    const s = /^export const (\w+) = \{$/.exec(lines[i]);
    if (s) sec = s[1];
    const sig = i + 1 < lines.length ? /^ {2}(\w+)\(req, ctx\) \{$/.exec(lines[i + 1]) : null;
    if (sec && /^ {2}\/\*\* .* \*\/$/.test(lines[i]) && sig) {
      const start = i;
      let j = i + 2;
      while (j < lines.length && lines[j] !== "  },") j++;
      if (j >= lines.length) return null;
      const key = `${sec}.${sig[1]}`;
      if (blocks.has(key)) return null;
      blocks.set(key, lines.slice(start, j + 1).join("\n"));
      skel.push(`<<${key}>>`);
      i = j;
      continue;
    }
    skel.push(lines[i]);
  }
  return { blocks, skeleton: skel.join("\n") };
}

// 块外骨架不变：原有的每一行原样、次序不变；只容许在块与块之间新插空行或整行 // 注释（例如在改过的函数上方写一句说明）
function hbSkeletonKept(orig: string, got: string): boolean {
  const a = orig.split("\n");
  const b = got.split("\n");
  const benign = (l: string) => /^\s*(\/\/.*)?$/.test(l);
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else if (!benign(line)) return false;
  }
  return i === a.length;
}

const HB_PROBE = (url: string) => `
const m = await import(${url});
const mk = (role, found) => {
  const log = [];
  const table = (t) => ({
    insert: (v) => (log.push([t, "insert"]), { id: "r1", ...v }),
    find: (id) => (log.push([t, "find", id]), found === undefined ? { id } : found),
    list: (q) => (log.push([t, "list", q.limit]), { rows: [], next: null }),
    update: (id, v) => (log.push([t, "update", id]), { id, ...v }),
    remove: (id) => (log.push([t, "remove", id]), true),
  });
  const db = new Proxy({}, { get: (_, t) => table(String(t)) });
  return { log, ctx: { user: { id: "u1", role }, db, audit: (a, id) => log.push(["audit", a, id]) } };
};
const run = (fn, req = {}, role = "member", found) => {
  const { log, ctx } = mk(role, found);
  let res;
  try { res = fn({ body: { a: 1 }, params: { id: "x1" }, query: {}, ...req }, ctx); } catch (e) { res = { threw: String(e?.message ?? e) }; }
  return { res, log };
};
console.log(JSON.stringify({
  t1: run(m.v2.createOrder),
  t2a: run(m.v2.listOrderItems), t2b: run(m.v2.listOrderItems, { query: { limit: "500" } }), t2c: run(m.v2.listOrderItems, { query: { limit: "35" } }),
  t3a: run(m.v2.updateUserProfile, { body: { invalid: true } }), t3b: run(m.v2.updateUserProfile),
  t4: run(m.admin.archiveUser, {}, "admin"),
  t5a: run(m.v2.deleteInvoice, {}, "member"), t5b: run(m.v2.deleteInvoice, {}, "admin"),
  t7a: run(m.v1.deleteInvoice, {}, "member"), t7b: run(m.v1.deleteInvoice, {}, "admin"),
  t6a: run(m.v2.getOrderDraft, {}, "member", { id: "x1", deletedAt: "2026-11-01" }), t6b: run(m.v2.getOrderDraft, {}, "member", { id: "x1", deletedAt: null }), t6c: run(m.v2.getOrderDraft, {}, "member", null),
}));
`;
type HbRun = { res: { status?: number; body?: Record<string, unknown> | null; threw?: string }; log: unknown[][] };
function hbBehaviour(dir: string): boolean[] {
  let o: Record<string, HbRun>;
  try {
    o = JSON.parse(probe(dir, HB_PROBE(importUrl(dir, "src/handlers.js"))) || "null");
  } catch {
    return HB_TARGETS.map(() => false);
  }
  if (!o) return HB_TARGETS.map(() => false);
  const has = (r: HbRun, op: string) => r.log.some((e) => e[1] === op);
  const limitOf = (r: HbRun) => r.log.find((e) => e[1] === "list")?.[2];
  const audit = (r: HbRun) => r.log.filter((e) => e[0] === "audit").map((e) => e[1]);
  return [
    o.t1.res.status === 201 && (o.t1.res.body?.data as { id?: string } | undefined)?.id === "r1" && has(o.t1, "insert"),
    o.t2a.res.status === 200 && limitOf(o.t2a) === 20 && limitOf(o.t2b) === 200 && limitOf(o.t2c) === 35,
    o.t3a.res.status === 422 && !has(o.t3a, "update") && o.t3b.res.status === 200 && has(o.t3b, "update"),
    o.t4.res.status === 200 && eqJson(audit(o.t4), ["admin.user.archive"]),
    o.t5a.res.status === 403 && o.t5a.res.body?.error === "forbidden" && !has(o.t5a, "remove") && o.t5b.res.status === 204 && has(o.t5b, "remove") && eqJson(audit(o.t5b), ["invoice.delete"]),
    o.t7a.res.status === 403 && o.t7a.res.body?.error === "forbidden" && !has(o.t7a, "remove") && o.t7b.res.status === 204 && has(o.t7b, "remove") && eqJson(audit(o.t7b), ["invoice.delete"]),
    o.t6a.res.status === 404 && o.t6a.res.body?.error === "not_found" && o.t6b.res.status === 200 && o.t6c.res.status === 404,
  ];
}

const HB_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { v1, v2, admin } from "../src/handlers.js";

const ctx = (role = "member") => {
  const audits = [];
  const table = () => ({
    insert: (v) => ({ id: "n1", ...v }),
    find: (id) => (id === "missing" ? null : { id }),
    list: () => ({ rows: [{ id: "a" }], next: null }),
    update: (id, v) => (id === "missing" ? null : { id, ...v }),
    remove: (id) => id !== "missing",
  });
  return { audits, user: { id: "u1", role }, db: new Proxy({}, { get: () => table() }), audit: (a) => audits.push(a) };
};

test("v2 getUser", () => {
  assert.deepEqual(v2.getUser({ params: { id: "u9" }, query: {} }, ctx()), { status: 200, body: { data: { id: "u9" } } });
  assert.equal(v2.getUser({ params: { id: "missing" }, query: {} }, ctx()).status, 404);
});

test("v1 list keeps the old shape", () => {
  const r = v1.listProducts({ query: {} }, ctx());
  assert.equal(r.status, 200);
  assert.equal(r.body.limit, 50);
});

test("admin needs an admin", () => {
  assert.throws(() => admin.getTeam({ params: { id: "t" }, query: {} }, ctx("member")), /forbidden/);
  assert.equal(admin.getTeam({ params: { id: "t" }, query: {} }, ctx("admin")).status, 200);
});

test("v2 validation", () => {
  assert.equal(v2.createTicket({ body: { invalid: true }, query: {} }, ctx()).status, 400);
  assert.equal(v2.createTicket({ body: { id: "x" }, query: {} }, ctx()).status, 400);
});
`;

// ── h2b-codegen：错误码表是生成物，正确做法是改生成源再重新生成 ─────────────────────────────────────

const ERR_ORIG = [
  { code: "E_BAD_REQUEST", http: 400, zh: "请求参数有误", en: "Bad request" },
  { code: "E_UNAUTHORIZED", http: 401, zh: "请先登录", en: "Please sign in" },
  { code: "E_FORBIDDEN", http: 403, zh: "没有权限", en: "Forbidden" },
  { code: "E_NOT_FOUND", http: 404, zh: "资源不存在", en: "Not found" },
  { code: "E_CONFLICT", http: 409, zh: "资源已被修改，请刷新后重试", en: "Conflict, please reload" },
  { code: "E_QUOTA_EXCEEDED", http: 429, zh: "请求过多，请稍后再试", en: "Too many requests" },
  { code: "E_RATE_LIMITED", http: 429, zh: "请求过于频繁，请稍后再试", en: "Rate limited" },
  { code: "E_INTERNAL", http: 500, zh: "服务器开小差了，请稍后再试", en: "Internal error" },
];
const ERR_QUOTA = { code: "E_QUOTA_EXCEEDED", http: 402, zh: "本月配额已用完，请升级套餐", en: "Monthly quota used up" };
const ERR_LARGE = { code: "E_FILE_TOO_LARGE", http: 413, zh: "文件超过 50 MB 上限", en: "File exceeds the 50 MB limit" };
const errJson = (list: typeof ERR_ORIG) => JSON.stringify({ errors: list }, null, 2) + "\n";

const GEN_ERRORS = `// 根据 codegen/errors.json 生成错误码相关的文件：src/generated/errors.js、src/generated/errors.d.ts、docs/errors.md，
// 以及 src/http-status.js 里 BEGIN / END GENERATED 之间的那一段。用法：npm run gen
import fs from "node:fs";

const at = (p) => new URL(\`../\${p}\`, import.meta.url);
const { errors } = JSON.parse(fs.readFileSync(at("codegen/errors.json"), "utf8"));
const list = [...errors].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
const seen = new Set();
for (const e of list) {
  if (!/^E_[A-Z0-9_]+$/.test(e.code)) throw new Error(\`bad code: \${e.code}\`);
  if (seen.has(e.code)) throw new Error(\`duplicate code: \${e.code}\`);
  seen.add(e.code);
  if (!Number.isInteger(e.http) || e.http < 400 || e.http > 599) throw new Error(\`bad http status for \${e.code}\`);
  if (!e.zh || !e.en) throw new Error(\`missing message for \${e.code}\`);
}

const HEADER = "// 此文件由 scripts/gen-errors.mjs 根据 codegen/errors.json 生成——DO NOT EDIT。改 codegen/errors.json 后运行 npm run gen。\\n";
const js =
  HEADER +
  "export const ERRORS = Object.freeze({\\n" +
  list.map((e, i) => \`  \${e.code}: { id: \${i + 1}, http: \${e.http}, zh: \${JSON.stringify(e.zh)}, en: \${JSON.stringify(e.en)} },\`).join("\\n") +
  "\\n});\\n\\nexport const ERROR_CODES = Object.freeze(Object.keys(ERRORS));\\n\\n" +
  'export function errorBody(code, lang = "zh") {\\n  const known = Object.hasOwn(ERRORS, code);\\n  const e = known ? ERRORS[code] : ERRORS.E_INTERNAL;\\n' +
  '  return { code: known ? code : "E_INTERNAL", id: e.id, message: lang === "en" ? e.en : e.zh };\\n}\\n';
const dts =
  HEADER +
  "export type ErrorCode =\\n" +
  list.map((e) => \`  | \${JSON.stringify(e.code)}\`).join("\\n") +
  ";\\n\\nexport declare const ERROR_CODES: readonly ErrorCode[];\\n" +
  'export declare function errorBody(code: ErrorCode, lang?: "zh" | "en"): { code: ErrorCode; id: number; message: string };\\n';
const md =
  "<!-- 由 scripts/gen-errors.mjs 生成，DO NOT EDIT -->\\n# 错误码\\n\\n| id | 错误码 | HTTP | 中文提示 | English |\\n|---|---|---|---|---|\\n" +
  list.map((e, i) => \`| \${i + 1} | \${e.code} | \${e.http} | \${e.zh} | \${e.en} |\`).join("\\n") +
  "\\n";
const region =
  "// BEGIN GENERATED status-by-code（npm run gen 维护，DO NOT EDIT）\\nconst STATUS_BY_CODE = {\\n" +
  list.map((e) => \`  \${e.code}: \${e.http},\`).join("\\n") +
  "\\n};\\n// END GENERATED status-by-code\\n";

fs.mkdirSync(at("src/generated/"), { recursive: true });
fs.mkdirSync(at("docs/"), { recursive: true });
fs.writeFileSync(at("src/generated/errors.js"), js);
fs.writeFileSync(at("src/generated/errors.d.ts"), dts);
fs.writeFileSync(at("docs/errors.md"), md);
const hs = fs.readFileSync(at("src/http-status.js"), "utf8");
const re = /\\/\\/ BEGIN GENERATED status-by-code[\\s\\S]*?\\/\\/ END GENERATED status-by-code\\n/;
if (!re.test(hs)) throw new Error("src/http-status.js 里找不到 GENERATED 段");
fs.writeFileSync(at("src/http-status.js"), hs.replace(re, () => region));
console.log(\`generated \${list.length} error codes\`);
`;
const HTTP_STATUS = `// HTTP 状态码映射。下面 GENERATED 那一段由 npm run gen 维护；段外是手写的。
// BEGIN GENERATED status-by-code（npm run gen 维护，DO NOT EDIT）
// END GENERATED status-by-code

export function statusOf(code) {
  return STATUS_BY_CODE[code] ?? 500;
}

export function isRetryable(code) {
  const s = statusOf(code);
  return s === 429 || s >= 500;
}
`;
const UPLOAD_SRC = `import { errorBody } from "./generated/errors.js";
import { statusOf } from "./http-status.js";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// 上传接口：file = { name, size }
export function upload(file, lang = "zh") {
  if (!file || !file.name) return fail("E_BAD_REQUEST", lang);
  if (file.size > MAX_UPLOAD_BYTES) return fail("E_BAD_REQUEST", lang);
  return { status: 201, body: { name: file.name, size: file.size } };
}

function fail(code, lang) {
  return { status: statusOf(code), body: errorBody(code, lang) };
}
`;
const QUOTA_SRC = `import { errorBody } from "./generated/errors.js";
import { statusOf } from "./http-status.js";

// 每月调用配额：used >= limit 时拒绝
export function checkQuota(account, lang = "zh") {
  if (account.used >= account.limit) return { status: statusOf("E_QUOTA_EXCEEDED"), body: errorBody("E_QUOTA_EXCEEDED", lang) };
  return null;
}
`;
const CODEGEN_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { errorBody, ERROR_CODES } from "../src/generated/errors.js";
import { statusOf, isRetryable } from "../src/http-status.js";
import { upload } from "../src/upload.js";

test("error bodies", () => {
  assert.equal(errorBody("E_NOT_FOUND").message, "资源不存在");
  assert.equal(errorBody("E_NOT_FOUND", "en").message, "Not found");
  assert.equal(errorBody("E_NOPE").code, "E_INTERNAL");
  assert.ok(ERROR_CODES.includes("E_CONFLICT"));
});

test("status map", () => {
  assert.equal(statusOf("E_FORBIDDEN"), 403);
  assert.equal(statusOf("E_NOPE"), 500);
  assert.equal(isRetryable("E_RATE_LIMITED"), true);
  assert.equal(isRetryable("E_NOT_FOUND"), false);
});

test("upload", () => {
  assert.equal(upload({ name: "a.png", size: 10 }).status, 201);
  assert.equal(upload({ size: 10 }).status, 400);
});
`;
// 前端那份文案表：另一个生成器，读 codegen/errors.json 再叠上手写的 codegen/web-overrides.json（前端改过口吻的条目）
const WEB_OVERRIDES = {
  $comment: "前端文案覆盖：这里的条目覆盖 errors.json 里同名错误码的提示（只覆盖写了的语言）。npm run gen:web 生成 web/src/errors.js。",
  E_CONFLICT: { zh: "内容已被别人修改，请刷新页面后重试" },
  E_QUOTA_EXCEEDED: { zh: "请求过多，请稍后再试", en: "Too many requests, please slow down" },
  E_INTERNAL: { en: "Something went wrong, please try again later" },
};
const GEN_WEB = `// 根据 codegen/errors.json + codegen/web-overrides.json 生成前端用的 web/src/errors.js。用法：npm run gen:web
import fs from "node:fs";

const at = (p) => new URL(\`../\${p}\`, import.meta.url);
const { errors } = JSON.parse(fs.readFileSync(at("codegen/errors.json"), "utf8"));
const overrides = JSON.parse(fs.readFileSync(at("codegen/web-overrides.json"), "utf8"));
const list = [...errors].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
for (const k of Object.keys(overrides)) {
  if (k !== "$comment" && !list.some((e) => e.code === k)) throw new Error(\`web-overrides.json 里的 \${k} 不在 errors.json 里\`);
}
const rows = list.map((e) => {
  const o = overrides[e.code] ?? {};
  return \`  \${e.code}: { status: \${e.http}, zh: \${JSON.stringify(o.zh ?? e.zh)}, en: \${JSON.stringify(o.en ?? e.en)} },\`;
});
const out =
  "// 此文件由 scripts/gen-web.mjs 根据 codegen/errors.json 与 codegen/web-overrides.json 生成——DO NOT EDIT。运行 npm run gen:web。\\n" +
  "export const WEB_ERRORS = {\\n" + rows.join("\\n") + "\\n};\\n\\n" +
  'export const messageOf = (code, lang = "zh") => (WEB_ERRORS[code] ?? WEB_ERRORS.E_INTERNAL)[lang === "en" ? "en" : "zh"];\\n';
fs.mkdirSync(at("web/src/"), { recursive: true });
fs.writeFileSync(at("web/src/errors.js"), out);
console.log(\`web: \${list.length} error codes\`);
`;
const CODEGEN_OUTPUTS = ["src/generated/errors.js", "src/generated/errors.d.ts", "docs/errors.md", "src/http-status.js", "web/src/errors.js"];
function regen(dir: string): boolean {
  return runNode(dir, ["scripts/gen-errors.mjs"]).status === 0 && runNode(dir, ["scripts/gen-web.mjs"]).status === 0;
}
// 把工作区复制一份、用原版生成脚本重新生成，生成物与工作区里的逐字节相同才算「同步」
function codegenInSync(dir: string): { ok: boolean; stale: string[] } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h2b-codegen-"));
  try {
    for (const rel of ["codegen/errors.json", "codegen/web-overrides.json", "src/http-status.js", "package.json"]) {
      const b = readBuf(dir, rel);
      if (b) write(tmp, rel, b);
    }
    write(tmp, "scripts/gen-errors.mjs", GEN_ERRORS);
    write(tmp, "scripts/gen-web.mjs", GEN_WEB);
    if (!regen(tmp)) return { ok: false, stale: ["生成失败"] };
    const stale = CODEGEN_OUTPUTS.filter((rel) => {
      const a = readBuf(dir, rel);
      const b = readBuf(tmp, rel);
      return !a || !b || !a.equals(b);
    });
    return { ok: stale.length === 0, stale };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ── h2b-encoding：BOM / CRLF / LF 混用的仓库里批量改名，再照样子新写一个 PowerShell 5.1 脚本 ─────────────────

// GBK 编码（cmd 的 .bat 按系统代码页 936 读）：Node 只有 GBK 解码器，反查一张双字节表来编码
let gbkTable: Map<string, number[]> | null = null;
function gbkEncode(s: string): Buffer {
  if (!gbkTable) {
    gbkTable = new Map();
    const dec = new TextDecoder("gbk");
    for (let hi = 0x81; hi <= 0xfe; hi++)
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue;
        const ch = dec.decode(Uint8Array.of(hi, lo));
        if (ch.length === 1 && ch !== "�" && !gbkTable.has(ch)) gbkTable.set(ch, [hi, lo]);
      }
  }
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else {
      const b = gbkTable.get(ch);
      if (!b) throw new Error(`GBK 编不了：${ch}`);
      out.push(...b);
    }
  }
  return Buffer.from(out);
}

type EncFile = { rel: string; bom: boolean; eol: "\r\n" | "\n"; lines: string[]; gbk?: boolean; utf16?: boolean };
const ENC_FILES: EncFile[] = [
  {
    rel: "config/yunfan.reg",
    bom: false,
    utf16: true,
    eol: "\r\n",
    lines: [
      "Windows Registry Editor Version 5.00",
      "",
      "[HKEY_CURRENT_USER\\Software\\YunFan]",
      '"DisplayName"="云帆 客户端"',
      '"InstallDir"="C:\\\\Program Files\\\\YunFan"',
      '"AppId"="yunfan"',
      "",
    ],
  },
  {
    rel: "scripts/启动.bat",
    bom: false,
    gbk: true,
    eol: "\r\n",
    lines: [
      "@echo off",
      "rem 云帆 启动脚本",
      "title YunFan",
      "set APP_ID=yunfan",
      "echo 云帆 正在启动……",
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0部署.ps1" -Version %1',
      "",
    ],
  },
  { rel: "assets/yunfan-logo.svg", bom: false, eol: "\n", lines: ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><title>YunFan</title><circle cx="32" cy="32" r="30"/></svg>', ""] },
  {
    rel: "scripts/部署.ps1",
    bom: true,
    eol: "\r\n",
    lines: [
      "param([Parameter(Mandatory = $true)][string]$Version)",
      "# 云帆 部署脚本（在 Windows PowerShell 5.1 里运行）",
      '$ErrorActionPreference = "Stop"',
      '$product = "云帆"',
      '$productId = "yunfan"',
      'Write-Output "${product}：开始部署 $Version"',
      'Write-Output "YunFan deploy $Version"',
      'Write-Output "目标目录：D:\\apps\\$productId\\$Version"',
      "",
    ],
  },
  {
    rel: "scripts/检查.ps1",
    bom: true,
    eol: "\r\n",
    lines: ["# 云帆 健康检查（在 Windows PowerShell 5.1 里运行）", '$product = "云帆"', 'Write-Output "${product}：检查服务状态"', 'Write-Output "YunFan health check"', ""],
  },
  {
    rel: "src/brand.js",
    bom: false,
    eol: "\n",
    lines: [
      "// 产品名（界面、日志、安装包都从这里取）",
      'export const PRODUCT_NAME = "云帆";',
      'export const PRODUCT_EN = "YunFan";',
      'export const PRODUCT_ID = "yunfan";',
      'export const LOGO = "assets/yunfan-logo.svg";',
      "export const installDir = (version) => `C:\\\\Program Files\\\\${PRODUCT_EN}\\\\${version}`;",
      "",
    ],
  },
  {
    rel: "src/i18n/zh-CN.json",
    bom: false,
    eol: "\n",
    lines: ["{", '  "app.title": "云帆 · 控制台",', '  "about": "关于云帆",', '  "welcome": "欢迎使用云帆！",', '  "update.available": "云帆有新版本可用"', "}", ""],
  },
  {
    rel: "data/客户名单.csv",
    bom: true,
    eol: "\r\n",
    lines: ["客户,产品,版本,备注", "华东一区,云帆专业版,3.2,续约", "华南二区,云帆标准版,3.1,", '西北大区,云帆专业版,3.2,"含 yunfan-cli 授权"', ""],
  },
  {
    rel: "config/app.ini",
    bom: false,
    eol: "\r\n",
    lines: ["; 云帆 服务配置", "[product]", "name = 云帆", "id = yunfan", "display = YunFan Server", "", "[paths]", "data = D:\\data\\yunfan", ""],
  },
  {
    rel: "README.md",
    bom: false,
    eol: "\n",
    lines: [
      "# 云帆",
      "",
      "YunFan（云帆）是内部用的部署与巡检工具。",
      "",
      "- 部署：`scripts/部署.ps1 -Version 3.2.0`",
      "- 巡检：`scripts/检查.ps1`",
      "- 双击启动：`scripts/启动.bat`",
      "- 图标：`assets/yunfan-logo.svg`",
      "- 注册表项：`config/yunfan.reg`（双击导入）",
      "- 安装目录：`C:\\Program Files\\YunFan\\<版本>`",
      "",
    ],
  },
];
const ENC_UNTOUCHED = { rel: "src/util.js", text: "// 与产品名无关的小工具\nexport const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n" };
const renameBrand = (s: string) => s.replace(/云帆/g, "云舟").replace(/YunFan/g, "YunZhou").replace(/yunfan/g, "yunzhou");
const encBytes = (f: EncFile, rename: boolean) => {
  const text = f.lines.map((l) => (rename ? renameBrand(l) : l)).join(f.eol);
  // .reg 是 regedit 导出的格式：UTF-16LE 带 BOM
  if (f.utf16) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  return Buffer.concat([f.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), f.gbk ? gbkEncode(text) : Buffer.from(text, "utf8")]);
};
const encPath = (f: EncFile, rename: boolean) => (rename ? renameBrand(f.rel) : f.rel);
const ROLLBACK_PS1 = [
  "param([Parameter(Mandatory = $true)][string]$Version)",
  "# 云舟 回滚脚本（在 Windows PowerShell 5.1 里运行）",
  '$ErrorActionPreference = "Stop"',
  '$product = "云舟"',
  'Write-Output "${product}：开始回滚 $Version"',
  'Write-Output "YunZhou rollback $Version"',
  "",
].join("\r\n");
const ROLLBACK_WANT = ["云舟：开始回滚 9.9.9", "YunZhou rollback 9.9.9"];
// 用 Windows PowerShell 5.1 跑新脚本（输出编码设成 UTF-8 再读）；不是 Windows 时退化为查 BOM
function runRollback(dir: string): { ok: boolean; got: string } {
  if (process.platform !== "win32") {
    const b = readBuf(dir, "scripts/回滚.ps1");
    return { ok: Boolean(b && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), got: "(非 Windows：只查 BOM)" };
  }
  if (!exists(dir, "scripts/回滚.ps1")) return { ok: false, got: "(没有 scripts/回滚.ps1)" };
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); & '.\\scripts\\回滚.ps1' -Version 9.9.9"],
    { cwd: dir, encoding: "utf8", timeout: 60_000 },
  );
  const lines = (r.stdout ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  return { ok: eqJson(lines, ROLLBACK_WANT), got: JSON.stringify(lines).slice(0, 120) };
}

// ── h2b-weird-path：文件名里有 $ ' & [ ] 两个连续空格、开头是短横线，用 PowerShell 脚本逐个处理 ─────────────────────

// 签订日期是各家合同模板里原样抄来的写法（年月日、斜杠、点号、中文数字、英文月份），归档按其中的年-月分目录
const WP_FILES: { name: string; body: string; month: string }[] = [
  { name: "A&B 公司 合同.txt", party: "A&B 公司", signed: "2026年10月3日", month: "2026-10" },
  { name: "O'Neil 报价 $100.txt", party: "O'Neil 贸易", signed: "2026/11/02", month: "2026-11" },
  { name: "[终版] 采购协议 (2).txt", party: "华北采购中心", signed: "2026-09-30", month: "2026-09" },
  { name: "-副本 租赁合同.txt", party: "东城物业", signed: "2026.8.15", month: "2026-08" },
  { name: "50% 定金 #3.txt", party: "南方设备", signed: "二〇二六年十一月五日", month: "2026-11" },
  { name: "税务  登记.txt", party: "城西税务所", signed: "2026年9月1日", month: "2026-09" },
  { name: "合同 v1.0 (王 & 李).txt", party: "王某 & 李某", signed: "Oct 28, 2026", month: "2026-10" },
].map((f, i) => ({
  name: f.name,
  month: f.month,
  body: `合同编号：HT-2026-${String(i + 101)}\n甲方：维度科技\n乙方：${f.party}\n金额：${(i + 3) * 1250} 元\n签订日期：${f.signed}\n`,
}));
const WP_IN = "收件箱";
const WP_DONE = "收件箱/已处理";
const wpDone = (f: { month: string; name: string }) => `${WP_DONE}/${f.month}/${f.name}`;
const WP_OUT = "已盖章 (2026) & 归档";
const STAMP_PS1 = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$Path,",
  "  [Parameter(Mandatory = $true)][string]$OutDir",
  ")",
  "# 给合同盖章：在文件开头加一行「盖章：<校验码>」，写到 OutDir 下（文件名不变），并在 tools/stamp.log 记一笔台账。",
  '$ErrorActionPreference = "Stop"',
  "$src = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)",
  "if (-not [System.IO.File]::Exists($src)) {",
  '  [Console]::Error.WriteLine("找不到文件：" + $Path)',
  "  exit 2",
  "}",
  "$name = [System.IO.Path]::GetFileName($src)",
  "$utf8 = New-Object System.Text.UTF8Encoding($false)",
  "$body = [System.IO.File]::ReadAllText($src, $utf8)",
  "$sha = New-Object System.Security.Cryptography.SHA256Managed",
  '$hash = ($sha.ComputeHash($utf8.GetBytes($name + "`n" + $body)) | ForEach-Object { $_.ToString("x2") }) -join ""',
  "$out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)",
  "[System.IO.Directory]::CreateDirectory($out) | Out-Null",
  "$dest = [System.IO.Path]::Combine($out, $name)",
  '[System.IO.File]::WriteAllText($dest, "盖章：" + $hash.Substring(0, 12) + "`r`n" + $body, $utf8)',
  '$log = [System.IO.Path]::Combine($PSScriptRoot, "stamp.log")',
  "$entry = @{ file = $name; out = $dest } | ConvertTo-Json -Compress",
  '[System.IO.File]::AppendAllText($log, $entry + "`r`n", $utf8)',
  'Write-Output ("已盖章：" + $name)',
  "",
].join("\r\n");
const stampOf = (f: { name: string; body: string }) => `盖章：${createHash("sha256").update(`${f.name}\n${f.body}`, "utf8").digest("hex").slice(0, 12)}\r\n${f.body}`;
const listDir = (dir: string, rel: string) => {
  try {
    return fs.readdirSync(path.join(dir, rel)).sort();
  } catch {
    return [];
  }
};

// ── h2b-big-output：回放日志 170 万字符，要定向统计，不能只看截断后的头尾 ─────────────────────────────────

// 造流量用的生成器（不进工作区；工作区里只有它的产物：一份 gzip 的抓包和回放脚本）
const TRAFFIC_GEN = `// 2026-11-06 的网关日志
let a = 20261106 >>> 0;
const r = () => {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(r() * xs.length)];
const N = 26000;
const routes = [
  ["GET", "/api/orders"], ["POST", "/api/orders"], ["POST", "/api/orders/pay"], ["GET", "/api/orders/history"], ["POST", "/api/upload"],
  ["GET", "/api/search"], ["GET", "/api/reports/export"], ["POST", "/api/auth/refresh"], ["POST", "/api/auth/login"], ["GET", "/api/cart"],
  ["POST", "/api/cart/items"], ["GET", "/api/products"], ["GET", "/api/products/detail"], ["GET", "/api/users/me"], ["PUT", "/api/users/me"],
  ["GET", "/api/notifications"], ["POST", "/api/notifications/read"], ["GET", "/api/coupons"], ["POST", "/api/coupons/redeem"], ["GET", "/api/shipments"],
  ["GET", "/api/shipments/track"], ["GET", "/api/invoices"], ["GET", "/api/invoices/pdf"], ["GET", "/api/settings"], ["PUT", "/api/settings"],
  ["GET", "/api/health"], ["GET", "/api/regions"], ["GET", "/api/currencies"], ["POST", "/api/feedback"], ["GET", "/api/banners"],
];
// 5xx 的分布（接口 → 次数），随机撒在整段回放里
const plan5xx = [["/api/orders/pay", 37], ["/api/upload", 29], ["/api/search", 18], ["/api/reports/export", 11], ["/api/auth/refresh", 6], ["/api/cart", 3]];
const at5xx = new Map();
for (const [p, n] of plan5xx) {
  for (let k = 0; k < n; k++) {
    let i;
    do i = 200 + Math.floor(r() * (N - 800)); while (at5xx.has(i));
    at5xx.set(i, p);
  }
}
const slow = new Map([[Math.floor(N * 0.31), 64200], [Math.floor(N * 0.58), 9870], [Math.floor(N * 0.83), 9410], [N - 150, 61050]]);
const dur = (ms) =>
  ms < 1000 ? \`\${ms}ms\` : ms < 60000 ? \`\${(ms / 1000).toFixed(2)}s\` : \`\${Math.floor(ms / 60000)}m\${((ms % 60000) / 1000).toFixed(2)}s\`;
const t0 = Date.UTC(2026, 10, 6, 0, 0, 0);
const out = [];
for (let i = 0; i < N; i++) {
  let [method, p] = pick(routes);
  let status = pick([200, 200, 200, 200, 200, 200, 200, 201, 204, 304, 400, 404]);
  let note = "";
  if (at5xx.has(i)) {
    p = at5xx.get(i);
    method = routes.find((x) => x[1] === p)[0];
    status = pick([500, 502, 503, 504]);
  } else if (r() < 0.012) note = pick(["upstream returned 503 then recovered", "fallback after 502 from inventory", "retried once after 504"]);
  let ms = 4 + Math.floor(Math.pow(r(), 3) * 900);
  if (r() < 0.015) ms = 1000 + Math.floor(r() * 6000);
  if (i === 7) ms = 1230;
  if (slow.has(i)) ms = slow.get(i);
  const ts = new Date(t0 + i * 3300).toISOString();
  const id = \`req-\${String(i + 1).padStart(6, "0")}\`;
  const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";
  out.push(\`\${ts} \${level} \${id} \${method} \${p} \${status} \${dur(ms)}\${note ? \` note="\${note}"\` : ""}\`);
  // 网关替这个请求调的上游（不是请求本身）
  if (i === 3 || r() < 0.02) {
    const us = i === 3 ? 503 : pick([200, 200, 503, 504]);
    out.push(\`\${ts} \${us >= 500 ? "WARN" : "INFO"} \${id} ↳ upstream \${pick(["inventory", "pricing", "search-backend"])} \${us} \${dur(2 + Math.floor(r() * 400))}\`);
  }
  if (out.length >= 500) {
    process.stdout.write(out.join("\\n") + "\\n");
    out.length = 0;
  }
}
process.stdout.write(out.join("\\n") + (out.length ? "\\n" : ""));
`;
const REPLAY_SRC = `// 回放昨天（2026-11-06）抓到的网关流量：把 data/gateway-2026-11-06.log.gz 按时间顺序逐条打印出来。
// 和线上的日志库一样：INFO 打到标准输出，WARN / ERROR 打到标准错误。
import fs from "node:fs";
import zlib from "node:zlib";

const dump = new URL("../data/gateway-2026-11-06.log.gz", import.meta.url);
const lines = zlib.gunzipSync(fs.readFileSync(dump)).toString("utf8").split("\\n").filter(Boolean);
let fd = 1;
let buf = [];
const flush = () => {
  if (buf.length) fs.writeSync(fd, buf.join("\\n") + "\\n");
  buf = [];
};
for (const line of lines) {
  const want = / (WARN|ERROR) /.test(line.slice(24, 31)) ? 2 : 1;
  if (want !== fd || buf.length >= 500) flush();
  fd = want;
  buf.push(line);
}
flush();
`;
let trafficMemo: string | null = null;
function traffic(): string {
  if (trafficMemo !== null) return trafficMemo;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", TRAFFIC_GEN], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (r.status !== 0 || !r.stdout) throw new Error(`h2b-big-output：造流量失败 ${r.stderr}`);
  trafficMemo = r.stdout;
  return trafficMemo;
}
let replayMemo: { by5xx: [string, number][]; slowest: string[]; lines: number; chars: number } | null = null;
function replayTruth() {
  if (replayMemo) return replayMemo;
  const text = traffic();
  const lines = text.split("\n").filter(Boolean);
  const count = new Map<string, number>();
  const durs: { id: string; ms: number }[] = [];
  for (const line of lines) {
    // 只认请求行（时间 请求号 方法 路径 状态码 耗时）；「↳ upstream」是网关调上游的记录，不是请求
    const f = /^\S+ (?:INFO|WARN|ERROR) (req-\d{6}) (?:GET|POST|PUT|DELETE) (\/\S*) (\d{3}) (\S+)/.exec(line);
    if (!f) continue;
    const status = Number(f[3]);
    if (status >= 500 && status <= 599) count.set(f[2], (count.get(f[2]) ?? 0) + 1);
    const d = /^(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)$/.exec(f[4]);
    if (d) durs.push({ id: f[1], ms: Number(d[1] ?? 0) * 60_000 + Number(d[2]) * (d[3] === "s" ? 1000 : 1) });
  }
  const by5xx = [...count].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const slowest = durs.sort((x, y) => y.ms - x.ms).slice(0, 3).map((x) => x.id);
  replayMemo = { by5xx, slowest, lines: lines.length, chars: text.length };
  return replayMemo;
}
// 一次 Read 实际读进上下文多少行：文件还在就按它的行数、offset 与 limit 算（limit 不设是 2000，设了可以更大）；
// 文件已不在（读完删了）只能按 limit 估
function readSpan(dir: string, c: CallRecord): number {
  const limit = Number(c.args.limit) > 0 ? Number(c.args.limit) : 2000;
  const offset = Number(c.args.offset) > 1 ? Number(c.args.offset) : 1;
  const p = callPath(c);
  let text: string | null = null;
  try {
    text = p ? fs.readFileSync(path.isAbsolute(p) ? p : path.join(dir, p), "utf8") : null;
  } catch {
    text = null;
  }
  if (text === null) return limit;
  const total = text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
  return Math.max(0, Math.min(limit, total - offset + 1));
}
const REPLAY_SMALL = /(^|\/)(tools\/[^/]+\.m?js|README\.md|package\.json|out\/5xx\.json|out\/slowest\.txt)$/;

// ── 题目 ─────────────────────────────────────────────────────────────────────

export const HARD2_B_TASKS: AbTask[] = [
  {
    id: "h2b-big-multi",
    title: "近 4000 行的处理函数文件里按评审意见改 7 条：三个版本段里同名函数各一份，近似重复的上下文很多，还有一条只限 v2 段的批量改",
    origin:
      "大文件多处修改：old_string 只带改动行（在三段里重复）、或带的上下文落在 v1 冻结段 / 名字相近的函数（createOrderItem、listOrders）上；" +
      "只限一段的批量替换用 replace_all / 全文件 sed 误伤另外两段、或批量覆盖了单独定的例外；「v1 冻结但安全问题要修」的例外漏掉；整份读入近 4000 行或整份重写",
    dimension: "编辑格式",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "7 个函数逐项用探针调用验行为（状态码、分页、审计动作、v1 / v2 越权、软删）；v2 其余 24 个 list* 只把默认 50 改成 25；其余 400 多个函数块与块外骨架逐字节不变" +
      "（v1 / admin 的 list*、相似函数都算）；测试全绿",
    prompt:
      "按代码评审意见改 src/handlers.js（v1 已冻结，只修安全问题）：\n" +
      "1. v2 的 createOrder 创建成功返回 201\n" +
      "2. v2 段所有 list 接口的默认每页条数从 50 改成 25，listOrderItems 例外、默认 20 条（上限 200 都不变）\n" +
      "3. v2 的 updateUserProfile 校验不通过返回 422\n" +
      "4. admin 的 archiveUser 审计动作写成了 admin.user.delete，应该是 admin.user.archive\n" +
      '5. deleteInvoice 有越权漏洞：只允许 ctx.user.role 为 "admin" 的用户删除，其他人返回 403、body 是 { error: "forbidden" }，并且不能执行删除。这是安全问题，v1 和 v2 都要修\n' +
      "6. v2 的 getOrderDraft：草稿已软删（rec.deletedAt 有值）时也按 404 not_found 处理\n" +
      "其他函数一个字都不要动。改完跑一下测试。",
    maxTurns: 44,
    deadlineMs: 18 * MIN,
    setup(dir) {
      write(dir, "package.json", pkgJson);
      write(dir, "src/handlers.js", HB_ORIG);
      write(dir, "src/routes.js", `// 路由表：方法 + 路径 → 段.函数名（节选）\nexport const routes = [\n${HB_RES.slice(0, 6).map((r) => `  ["POST", "/v2/${kebab(plural(r))}", "v2.create${cap(r)}"],`).join("\n")}\n];\n`);
      write(dir, "test/handlers.test.js", HB_TEST);
    },
    check(dir) {
      const text = read(dir, "src/handlers.js") ?? "";
      const got = hbParse(text);
      const orig = hbParse(HB_ORIG)!;
      if (!got) return { pass: false, detail: "parse=broken（函数块结构被破坏）" };
      const changed = [...orig.blocks]
        .filter(([k, v]) => !HB_TARGETS.includes(k) && got.blocks.get(k) !== (HB_V2_LISTS.includes(k) ? hbList25(v) : v))
        .map(([k]) => k);
      const skeleton = hbSkeletonKept(orig.skeleton, got.skeleton);
      const missing = HB_TARGETS.filter((k) => !got.blocks.has(k));
      const beh = hbBehaviour(dir);
      const t = nodeTests(dir);
      const lf = !text.includes("\r\n");
      const pass = beh.every(Boolean) && changed.length === 0 && skeleton && missing.length === 0 && t.ok && lf;
      return {
        pass,
        detail:
          `items=${beh.map((b) => (b ? 1 : 0)).join("")} collateral=${changed.length}${changed.length ? `（${changed.slice(0, 4).join(",")}${changed.length > 4 ? "…" : ""}）` : ""} ` +
          `skeleton=${skeleton} lf=${lf} tests=${t.tests}/${t.failed}fail`,
      };
    },
    reference: { solve: (dir) => write(dir, "src/handlers.js", hbReference()) },
  },
  {
    id: "h2b-codegen",
    title: "生成物别手改：错误码表由脚本生成，改生成源再重新生成（还要新增一个码）",
    origin:
      "grep 到文案就直接改 src/generated/ 里标着 DO NOT EDIT 的文件；手工追加新码时漏了 .d.ts / 文档 / 状态码段，或编号没按生成规则重排；" +
      "只跑了后端的生成、没跑前端那份（npm run gen:web），或没发现前端文案覆盖表把旧提示又盖了回去",
    dimension: "编辑格式",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "codegen/errors.json 里两个码与题面一字不差、其余条目不变；用原版两个生成脚本对工作区重新生成，5 份生成物（errors.js / errors.d.ts / docs/errors.md / http-status.js 的生成段 / web/src/errors.js）逐字节一致；" +
      "生成脚本未改；探针：接口配额 402 + 新文案、上传超限 413 + E_FILE_TOO_LARGE（中英文）；前端提示条两条新文案都对、别的覆盖条目照旧；测试全绿",
    prompt:
      "用户反馈两个问题，帮我修一下：\n" +
      "1. 本月配额用完时，接口返回的是 429，前端弹出的提示是「请求过多，请稍后再试」。应该返回 402，提示（接口返回的和前端弹出的都算）中文「本月配额已用完，请升级套餐」，英文「Monthly quota used up」。\n" +
      "2. 上传超过 50 MB 的文件时现在返回的是通用的 E_BAD_REQUEST。新增一个错误码 E_FILE_TOO_LARGE（HTTP 413，中文「文件超过 50 MB 上限」，英文「File exceeds the 50 MB limit」），上传接口超限时返回它，前端也要能显示这条提示。\n" +
      "改完跑一下测试。",
    maxTurns: 28,
    deadlineMs: 10 * MIN,
    setup(dir) {
      write(
        dir,
        "package.json",
        JSON.stringify({ name: "api-errors", type: "module", scripts: { test: "node --test", gen: "node scripts/gen-errors.mjs", "gen:web": "node scripts/gen-web.mjs" } }, null, 2) + "\n",
      );
      write(dir, "codegen/errors.json", errJson(ERR_ORIG));
      write(dir, "codegen/web-overrides.json", JSON.stringify(WEB_OVERRIDES, null, 2) + "\n");
      write(dir, "scripts/gen-errors.mjs", GEN_ERRORS);
      write(dir, "scripts/gen-web.mjs", GEN_WEB);
      write(dir, "web/src/toast.js", 'import { messageOf } from "./errors.js";\n\n// 接口报错时弹出的提示条：按错误码取前端文案\nexport const toastFor = (res, lang = "zh") => ({ kind: "error", text: messageOf(res.body?.code, lang) });\n');
      write(dir, "src/http-status.js", HTTP_STATUS);
      write(dir, "src/upload.js", UPLOAD_SRC);
      write(dir, "src/quota.js", QUOTA_SRC);
      write(dir, "test/errors.test.js", CODEGEN_TEST);
      if (!regen(dir)) throw new Error("h2b-codegen：setup 里生成失败");
    },
    check(dir) {
      const list = (readJson(dir, "codegen/errors.json") as { errors?: typeof ERR_ORIG } | undefined)?.errors;
      const byCode = new Map((Array.isArray(list) ? list : []).map((e) => [e?.code, e]));
      const quota = eqObj(byCode.get(ERR_QUOTA.code), ERR_QUOTA);
      const large = eqObj(byCode.get(ERR_LARGE.code), ERR_LARGE);
      const othersKept = ERR_ORIG.filter((e) => e.code !== ERR_QUOTA.code).every((e) => eqObj(byCode.get(e.code), e)) && byCode.size === ERR_ORIG.length + 1;
      const genKept = sha(read(dir, "scripts/gen-errors.mjs")) === sha(GEN_ERRORS) && sha(read(dir, "scripts/gen-web.mjs")) === sha(GEN_WEB);
      const sync = codegenInSync(dir);
      const beh = probe(
        dir,
        `const u = await import(${importUrl(dir, "src/upload.js")}); const q = await import(${importUrl(dir, "src/quota.js")});` +
          `const big = { name: "a.mp4", size: 60 * 1024 * 1024 };` +
          `const a = u.upload(big), b = u.upload(big, "en"), c = q.checkQuota({ used: 5, limit: 5 }), d = q.checkQuota({ used: 5, limit: 5 }, "en");` +
          `console.log(JSON.stringify([a.status, a.body.code, a.body.message, b.body.message, c.status, c.body.message, d.body.message, u.upload({ name: "x", size: 1 }).status]));`,
      );
      const behOk = beh === JSON.stringify([413, ERR_LARGE.code, ERR_LARGE.zh, ERR_LARGE.en, 402, ERR_QUOTA.zh, ERR_QUOTA.en, 201]);
      // 前端提示条（用户看到的那句）：配额两种语言都是新文案、新码有文案；别的覆盖条目照旧生效
      const web = probe(
        dir,
        `const t = await import(${importUrl(dir, "web/src/toast.js")}); const w = await import(${importUrl(dir, "web/src/errors.js")});` +
          `const q = { body: { code: "E_QUOTA_EXCEEDED" } }, l = { body: { code: "E_FILE_TOO_LARGE" } };` +
          `console.log(JSON.stringify([t.toastFor(q).text, t.toastFor(q, "en").text, w.WEB_ERRORS.E_QUOTA_EXCEEDED?.status, t.toastFor(l).text, t.toastFor(l, "en").text, w.WEB_ERRORS.E_FILE_TOO_LARGE?.status, w.messageOf("E_CONFLICT"), w.messageOf("E_INTERNAL", "en")]));`,
      );
      const webOk =
        web === JSON.stringify([ERR_QUOTA.zh, ERR_QUOTA.en, 402, ERR_LARGE.zh, ERR_LARGE.en, 413, WEB_OVERRIDES.E_CONFLICT.zh, WEB_OVERRIDES.E_INTERNAL.en]);
      const t = nodeTests(dir);
      return {
        pass: quota && large && othersKept && genKept && sync.ok && behOk && webOk && t.ok,
        detail: `source=${quota}/${large}/${othersKept} inSync=${sync.ok}${sync.stale.length ? `（${sync.stale.join(",")}）` : ""} genKept=${genKept} behaviour=${behOk} web=${webOk}（${web.slice(0, 70)}） tests=${t.tests}/${t.failed}fail`,
      };
    },
    reference: {
      solve(dir) {
        write(dir, "codegen/errors.json", errJson([...ERR_ORIG.map((e) => (e.code === ERR_QUOTA.code ? ERR_QUOTA : e)), ERR_LARGE]));
        write(dir, "codegen/web-overrides.json", JSON.stringify({ ...WEB_OVERRIDES, E_QUOTA_EXCEEDED: undefined }, null, 2) + "\n");
        write(dir, "src/upload.js", UPLOAD_SRC.replace('if (file.size > MAX_UPLOAD_BYTES) return fail("E_BAD_REQUEST", lang);', 'if (file.size > MAX_UPLOAD_BYTES) return fail("E_FILE_TOO_LARGE", lang);'));
        if (!regen(dir)) throw new Error("h2b-codegen：参考解生成失败");
      },
    },
  },
  {
    id: "h2b-encoding",
    title: "BOM / CRLF / LF 混用的仓库里改产品名，再照样子新写一个 Windows PowerShell 5.1 脚本",
    origin:
      "Windows 仓库批量替换：Git Bash 的 sed -i 把 CRLF 变 LF、PowerShell 的 Get-Content / Set-Content 把 LF 变 CRLF 或加 BOM；Write 整份重写丢掉 BOM / CRLF；" +
      "按 UTF-8 grep 不到 GBK 的 .bat（cmd 按代码页 936 读）与 UTF-16LE 的 .reg（regedit 导出格式），漏改或转成 UTF-8；文件名里的旧名与引用它的地方没跟着改；" +
      "新写的含中文 .ps1 不带 BOM，Windows PowerShell 5.1 按 ANSI 读、中文全成乱码",
    dimension: "编辑格式",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "10 个含旧名的文件（含 GBK 的 .bat、UTF-16LE 的 .reg、改了名的 svg / reg）与预期逐字节相等（三种写法全改、各自的编码 / BOM / 换行原样）；无关文件不变；工作区里的文件名与 UTF-8 内容不再有旧名（含 .bak 之类的备份）；" +
      "新脚本 scripts/回滚.ps1 用 Windows PowerShell 5.1 跑 -Version 9.9.9，输出恰好两行且中文正确",
    prompt:
      "产品改名：云帆 → 云舟（英文 YunFan → YunZhou，标识 yunfan → yunzhou），仓库里所有出现的地方都要改，文件名里的也算。" +
      "然后照 scripts/部署.ps1 的样子新写一个 scripts/回滚.ps1：参数 -Version，运行后输出两行：`云舟：开始回滚 <版本>` 和 `YunZhou rollback <版本>`。" +
      "这些脚本都是在 Windows PowerShell 5.1 里跑的。除了改名，别的一律不要动。",
    maxTurns: 32,
    deadlineMs: 12 * MIN,
    setup(dir) {
      for (const f of ENC_FILES) write(dir, encPath(f, false), encBytes(f, false));
      write(dir, ENC_UNTOUCHED.rel, ENC_UNTOUCHED.text);
    },
    check(dir) {
      const wrong = ENC_FILES.filter((f) => !readBuf(dir, encPath(f, true))?.equals(encBytes(f, true))).map((f) => {
        const b = readBuf(dir, encPath(f, true));
        if (!b) return `${encPath(f, true)}(没有)`;
        const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
        const s = f.gbk ? new TextDecoder("gbk").decode(b) : f.utf16 ? b.subarray(2).toString("utf16le") : b.toString("utf8");
        const crlf = s.includes("\r\n");
        const bareLf = /(^|[^\r])\n/.test(s);
        const eol = crlf && bareLf ? "mixed" : crlf ? "crlf" : "lf";
        const enc = f.gbk ? (b.equals(Buffer.from(b.toString("utf8"), "utf8")) && /[^\x00-\x7f]/.test(b.toString("utf8")) ? "utf8" : "gbk?") : "";
        return `${path.basename(f.rel)}(bom=${bom ? 1 : 0}/${f.bom ? 1 : 0} eol=${eol}/${f.eol === "\r\n" ? "crlf" : "lf"}${enc ? ` enc=${enc}` : ""} old=${/云帆|YunFan|yunfan/.test(s)})`;
      });
      const untouched = read(dir, ENC_UNTOUCHED.rel) === ENC_UNTOUCHED.text;
      // 仍带旧名的文件：现场原有的（改名后路径）与新脚本算「改名不全」；模型自己留在工作区的文件（改名辅助脚本、.bak 备份……）单独列为「遗留杂物」，同样判败
      const known = new Set([...ENC_FILES.map((f) => encPath(f, true)), ENC_UNTOUCHED.rel, "scripts/回滚.ps1"]);
      const oldName = (f: string) => /云帆|YunFan|yunfan/i.test(f) || /云帆|YunFan|yunfan/.test(readBuf(dir, f)?.toString("utf8") ?? "");
      const all = filesUnder(dir);
      const leftovers = all.filter((f) => known.has(f) && oldName(f));
      const stray = all.filter((f) => !known.has(f) && oldName(f));
      const rb = runRollback(dir);
      return {
        pass: wrong.length === 0 && untouched && leftovers.length === 0 && stray.length === 0 && rb.ok,
        detail:
          `wrongFiles=${wrong.length ? wrong.join(" ") : "-"} untouched=${untouched} leftovers=${leftovers.join(",") || "-"} ` +
          `strayWithOldName=${stray.join(",") || "-"} rollback=${rb.ok} out=${rb.got}`,
      };
    },
    reference: {
      solve(dir) {
        for (const f of ENC_FILES) {
          if (encPath(f, true) !== f.rel) fs.rmSync(path.join(dir, f.rel));
          write(dir, encPath(f, true), encBytes(f, true));
        }
        write(dir, "scripts/回滚.ps1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ROLLBACK_PS1, "utf8")]));
      },
    },
  },
  {
    id: "h2b-weird-path",
    title: "文件名里有 $ ' & [ ] 和两个连续空格：逐个交给 PowerShell 脚本盖章，再按签订日期分月归档原件",
    origin:
      "Windows 上 shell 引用：bash 双引号里的 $100 被展开成 00、单引号遇到 O'Neil 断开、没加引号的变量把两个空格压成一个；" +
      "powershell -Command 再解析一遍（$ 与 ' 又被吃一次）；-Path 把 [终版] 当通配符；签订日期写法五花八门（2026.8.15、二〇二六年十一月五日、Oct 28, 2026），归档月份认错",
    dimension: "工具调用健壮性",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "7 份合同在「已盖章 (2026) & 归档」下各有一份盖章文件（文件名一字不差、内容 = 脚本算出的校验码 + 原文）；tools/stamp.log 里 7 个文件都有台账；" +
      "原件都在 收件箱/已处理/<签订年-月>/ 下、内容不变，收件箱顶层只剩 已处理/、已处理/ 下只有那几个月份目录；会话里有成功跑 stamp.ps1 的命令",
    prompt:
      "收件箱/ 里有 7 份合同（.txt），帮我逐份用 tools/stamp.ps1 盖章，输出目录是 `已盖章 (2026) & 归档`，文件名保持不变。" +
      "盖章必须用这个脚本（它会记台账），不要自己生成盖章文件。全部盖完后，把收件箱里的原件按合同里写的签订日期归档到 收件箱/已处理/<年>-<月>/ 下（例如 收件箱/已处理/2026-10/），文件名不变。",
    maxTurns: 30,
    deadlineMs: 12 * MIN,
    setup(dir) {
      write(dir, "tools/stamp.ps1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(STAMP_PS1, "utf8")]));
      for (const f of WP_FILES) write(dir, `${WP_IN}/${f.name}`, f.body);
    },
    check(dir, rec) {
      const stamped = WP_FILES.filter((f) => read(dir, `${WP_OUT}/${f.name}`) === stampOf(f)).length;
      const outExtra = listDir(dir, WP_OUT).filter((n) => !WP_FILES.some((f) => f.name === n));
      const moved = WP_FILES.filter((f) => read(dir, wpDone(f)) === f.body).length;
      const months = [...new Set(WP_FILES.map((f) => f.month))].sort();
      const doneExtra = listDir(dir, WP_DONE).filter((n) => !months.includes(n));
      const inboxLeft = listDir(dir, WP_IN).filter((n) => n !== "已处理");
      const logged = new Set(
        (read(dir, "tools/stamp.log") ?? "")
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [String((JSON.parse(l.replace(/^\uFEFF/, "")) as { file?: string }).file)];
            } catch {
              return [];
            }
          }),
      );
      const ledger = WP_FILES.filter((f) => logged.has(f.name)).length;
      // 跑过脚本：成功退出的命令里点了 stamp.ps1，或点了会话里写下、正文调用 stamp.ps1 的包装脚本（只写不跑不算）；
      // 用 Write / Edit 直接写盖章目录或台账（自己算校验码伪造）判败；脚本本身也不许改
      const calls = toolCalls(rec);
      const wrappers = calls
        .filter((c) => (c.name === "Write" || c.name === "Edit") && /stamp\.ps1/i.test(String(c.args.content ?? c.args.new_string ?? "")))
        .map((c) => path.basename(callPath(c)))
        .filter(Boolean);
      const ran = calls.some((c) => {
        const cmd = callCommand(c);
        return c.ok === true && cmd !== "" && (/stamp\.ps1/i.test(cmd) || wrappers.some((w) => cmd.includes(w)));
      });
      const forged = calls.filter((c) => (c.name === "Write" || c.name === "Edit") && (callPath(c).includes(WP_OUT) || /(^|\/)tools\/stamp\.log$/i.test(callPath(c)))).length;
      const scriptKept = readBuf(dir, "tools/stamp.ps1")?.equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(STAMP_PS1, "utf8")])) === true;
      return {
        pass:
          stamped === WP_FILES.length && outExtra.length === 0 && moved === WP_FILES.length && inboxLeft.length === 0 && doneExtra.length === 0 &&
          ledger === WP_FILES.length && ran && forged === 0 && scriptKept,
        detail:
          `stamped=${stamped}/7 extraOut=${JSON.stringify(outExtra)} moved=${moved}/7 inboxLeft=${JSON.stringify(inboxLeft)} doneExtra=${JSON.stringify(doneExtra)} ` +
          `ledger=${ledger}/7 ranScript=${ran} forgedWrites=${forged} scriptKept=${scriptKept}`,
      };
    },
    reference: {
      solve(dir) {
        const log: string[] = [];
        for (const f of WP_FILES) {
          write(dir, `${WP_OUT}/${f.name}`, stampOf(f));
          fs.mkdirSync(path.dirname(path.join(dir, wpDone(f))), { recursive: true });
          fs.renameSync(path.join(dir, WP_IN, f.name), path.join(dir, wpDone(f)));
          log.push(JSON.stringify({ file: f.name, out: path.join(dir, WP_OUT, f.name) }));
        }
        write(dir, "tools/stamp.log", log.join("\r\n") + "\r\n");
      },
      calls: [{ name: "Bash", args: { command: `for f in 收件箱/*.txt; do powershell -NoProfile -ExecutionPolicy Bypass -File tools/stamp.ps1 -Path "$f" -OutDir '${WP_OUT}'; done` } }],
    },
  },
  {
    id: "h2b-big-output",
    title: "命令输出 170 多万字符：统计 5xx 与最慢请求，要定向处理全量，不能看截断的头尾下结论",
    origin:
      "超长输出只留头 5K 尾 25K：模型拿可见的那一段数数就交差，或者把落盘的全文整份 Read 进上下文（几十万 token）；" +
      "按文本 grep 状态码把备注里的 503、网关调上游的「↳ upstream … 503」记录也算成请求；耗时有 ms / s / 1m4.20s 三种写法，只按数字或只认两种单位排序；WARN / ERROR 打在标准错误，只把标准输出重定向进文件就把 5xx 全丢了",
    dimension: "工具调用健壮性",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "out/5xx.json 的条目与顺序与全量统计（只数请求行）相等；out/slowest.txt 恰好三行、请求号与顺序正确（含分钟级耗时）；会话里对大文件的 Read 合计不超过 6000 行（没有把全文读进上下文）",
    prompt:
      "帮我跑一下 node tools/replay.mjs（回放昨天的网关流量，会逐条打印请求日志），然后：\n" +
      "1. 统计状态码为 5xx 的请求，按接口路径计数，写进 out/5xx.json，格式是 {\"路径\": 次数}，按次数从多到少排；\n" +
      "2. 找出耗时最长的 3 个请求，把请求号（req-xxxxxx）按耗时从长到短写进 out/slowest.txt，一行一个。",
    maxTurns: 24,
    deadlineMs: 10 * MIN,
    setup(dir) {
      write(dir, "package.json", pkgJson);
      write(dir, "tools/replay.mjs", REPLAY_SRC);
      write(dir, "data/gateway-2026-11-06.log.gz", zlib.gzipSync(Buffer.from(traffic(), "utf8")));
      write(dir, "README.md", "# 网关回放\n\n`node tools/replay.mjs` 把昨天的请求日志按时间顺序打印到标准输出。\n");
    },
    check(dir, rec) {
      const truth = replayTruth();
      const got = readJson(dir, "out/5xx.json");
      const entries = got && typeof got === "object" && !Array.isArray(got) ? Object.entries(got as Record<string, unknown>) : null;
      const countsOk = eqJson(entries, truth.by5xx);
      const slow = (read(dir, "out/slowest.txt") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const slowOk = eqJson(slow, truth.slowest);
      const readLines = toolCalls(rec)
        .filter((c) => c.name === "Read" && !REPLAY_SMALL.test(callPath(c)))
        .reduce((n, c) => n + readSpan(dir, c), 0);
      return {
        pass: countsOk && slowOk && readLines <= 6000,
        detail: `5xx=${countsOk}（${JSON.stringify(entries ?? null).slice(0, 90)}） slowest=${slowOk}（${slow.join(",") || "-"}） bigReadLines=${readLines}`,
      };
    },
    reference: {
      solve(dir) {
        const truth = replayTruth();
        write(dir, "out/5xx.json", JSON.stringify(Object.fromEntries(truth.by5xx), null, 2) + "\n");
        write(dir, "out/slowest.txt", truth.slowest.join("\n") + "\n");
      },
    },
  },
];
