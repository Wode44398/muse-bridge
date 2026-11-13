// 模型档案 P0 第二批难题（a 组：长跨度编码与调试）：主要用来比 token / 步数 / 工具与编辑失败率，以及较弱型号的通过率。
// 规则同 tasks-hard.ts：setup 摆现场、check 确定性判分、reference 参考解；suite 写 "hard2"。
// 这一组难在真实工作里的调试与重构失误：修一个暴露下一个的连锁失败（npm test 后半段的 golden 只在单测全绿后才跑）、
// 报错栈指向的不是病根、日志里第二条同类告警题面没提、生成产物与源码两份、拆模块漏掉共享状态与活绑定、
// 性能优化改变了输出。判分一律看磁盘状态 + 自己跑测试 + 另跑一套审阅测试（reviewer：按题面 / README 写明的规则在新进程里查，
// 模型看不到）；不看答复措辞。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AbTask } from "./tasks.ts";
import { filesUnder, nodeTests, pkgJson, probe, read, rng, write } from "./task-kit.ts";

const MIN = 60_000;
const url = (abs: string) => JSON.stringify(pathToFileURL(abs).href);
const T_HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';

// 审阅测试的公用开头：t(名字, 函数) 记一条成败（抛错算败），最后一行打印 JSON。canon 是对象键排好序的 JSON，same 按它比——
// 模型重写时换了返回对象里键的先后（README / 测试都没规定顺序）不该判败
const REVIEW_PRELUDE = `const R = {};
const t = async (name, fn) => { try { R[name] = Boolean(await fn()); } catch { R[name] = false; } };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);
`;
const REVIEW_END = "\nconsole.log(JSON.stringify(R));\n";

// 跑一段审阅脚本（新进程），返回 {检查名: 成败}；脚本崩了 / 没输出 JSON 时是 null
function review(cwd: string, body: string): Record<string, boolean> | null {
  const out = probe(cwd, REVIEW_PRELUDE + body + REVIEW_END);
  try {
    const v = JSON.parse(out.split(/\r?\n/).pop() ?? "");
    return v && typeof v === "object" ? (v as Record<string, boolean>) : null;
  } catch {
    return null;
  }
}
// 几段审阅脚本各跑一个进程（各自一份全新的模块图），合并结果；某段没跑起来就记成「<名字>:没跑起来」
function reviews(cwd: string, parts: Record<string, string>): Record<string, boolean> {
  const all: Record<string, boolean> = {};
  for (const [name, body] of Object.entries(parts)) Object.assign(all, review(cwd, body) ?? { [`${name}:没跑起来`]: false });
  return all;
}
const failedOf = (r: Record<string, boolean>) => Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
const listShort = (xs: string[], n = 10) => (xs.length ? xs.slice(0, n).join(",") + (xs.length > n ? `…（共 ${xs.length}）` : "") : "-");

// 题目原样带的文件有没有被改过（「别改测试」的题）；按 LF 归一后比
function edited(dir: string, files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([rel, text]) => ((read(dir, rel) ?? "").replace(/\r\n/g, "\n") === text ? [] : [rel]));
}

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const childEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
function runNode(cwd: string, args: string[], timeout = 30_000) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout, env: childEnv(), maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ms: Date.now() - t0, timedOut: r.error !== undefined || r.signal !== null };
}

// RFC 4180 解析（判分与冒烟用；比题目现场的实现严格）
const RFC_PARSE_JS = `function rfcParse(text) {
  const rows = []; let row = []; let f = ""; let q = false; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"' && f === "") { q = true; i++; continue; }
    if (c === ",") { row.push(f); f = ""; i++; continue; }
    if (c === "\\r" && text[i + 1] === "\\n") { row.push(f); rows.push(row); row = []; f = ""; i += 2; continue; }
    if (c === "\\n") { row.push(f); rows.push(row); row = []; f = ""; i++; continue; }
    f += c; i++;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
`;

// ═══ h2a-cascade：npm test 一片红，修一个暴露下一个；后半段 golden 只在单测全绿后才跑 ═══════════

const INV_README = `# invoice-kit

开票计算。金额一律以「元」为单位的 number 进出。\`npm test\` = 单元测试 + golden 用例（scripts/golden.js）。

## 规则

1. 舍入：每一步的结果都四舍五入到分，按绝对值四舍五入（负数对称：-1.005 → -1.01，1.005 → 1.01）。
2. 行金额 = 舍入(price × qty)；qty 缺省为 1，qty 为 0 的行金额为 0。小计 = 各行金额之和。
3. 订单折扣：先减券（coupon，元），再打折（percent，0–100）；折后金额不低于 0。
4. 折扣分摊：订单折扣总额（小计 − 折后金额）按各行金额占小计的比例分摊到各行，每行舍入到分；分摊尾差（折扣总额 − 各行分摊之和）
   全部计入金额最大的那一行（并列取最靠前的）。小计为 0 时各行分摊都是 0。
5. 税：每行按自己的税类（category，缺省 standard；reduced 用 data/rates-reduced.json）取开票日期当时生效的税率
   （effective 当天起生效）。税率表是运营手工维护的，不保证按日期排序。行税额 = 舍入(行折后金额 × 税率)，税额 = 各行税额之和。
6. 合计 = 折后金额 + 税额。
`;
type Rate = { effective: string; rate: number };
const RATES_STD: Rate[] = [
  { effective: "2020-01-01", rate: 0.06 },
  { effective: "2024-07-01", rate: 0.09 },
  { effective: "2022-01-01", rate: 0.08 },
];
const RATES_RED: Rate[] = [
  { effective: "2020-01-01", rate: 0.03 },
  { effective: "2023-04-01", rate: 0.05 },
  { effective: "2021-01-01", rate: 0.04 },
];
const ratesJson = (t: Rate[]) => "[\n" + t.map((r) => `  { "effective": "${r.effective}", "rate": ${r.rate} }`).join(",\n") + "\n]\n";

const INV_SRC: Record<string, string> = {
  "src/round.js": "// 金额舍入到分\nexport function roundCents(x) {\n  return Math.round(x * 100) / 100;\n}\n",
  "src/rates.js":
    'import standard from "../data/rates.json";\nimport reduced from "../data/rates-reduced.json";\n\nconst TABLES = { standard, reduced };\n\n' +
    "// 按开票日期（YYYY-MM-DD）与税类取生效的税率\nexport function rateFor(date, category = \"standard\") {\n  const table = TABLES[category] ?? standard;\n" +
    "  let rate = table[0].rate;\n  for (const r of table) if (r.effective < date) rate = r.rate;\n  return rate;\n}\n",
  "src/discount.js":
    'import { roundCents } from "./round.js";\n\n// 先减券（coupon，元），再打折（percent，0–100）\nexport function applyDiscounts(subtotal, { coupon = 0, percent = 0 } = {}) {\n' +
    "  const afterPercent = subtotal * (1 - percent / 100);\n  return roundCents(afterPercent - coupon);\n}\n",
  "src/allocate.js":
    'import { roundCents } from "./round.js";\n\n// 把订单折扣 total 按各行金额比例分摊到各行（每行舍入到分），尾差计入最后一行\nexport function allocate(total, amounts) {\n' +
    "  const sum = amounts.reduce((n, a) => n + a, 0);\n  const shares = amounts.map((a) => roundCents((total * a) / sum));\n" +
    "  const diff = roundCents(total - shares.reduce((n, s) => n + s, 0));\n  shares[shares.length - 1] = roundCents(shares[shares.length - 1] + diff);\n  return shares;\n}\n",
  "src/invoice.js":
    'import { allocate } from "./allocate.js";\nimport { applyDiscounts } from "./discount.js";\nimport { rateFor } from "./rates.js";\nimport { roundCents } from "./round.js";\n\n' +
    "export function buildInvoice({ date, lines, coupon, percent }) {\n  const amounts = lines.map((l) => roundCents(l.price * (l.qty || 1)));\n" +
    "  const subtotal = roundCents(amounts.reduce((n, a) => n + a, 0));\n  const discounted = applyDiscounts(subtotal, { coupon, percent });\n" +
    "  const shares = allocate(roundCents(subtotal - discounted), amounts);\n  const out = lines.map((l, i) => {\n    const net = roundCents(amounts[i] - shares[i]);\n" +
    "    return { amount: amounts[i], discount: shares[i], net, tax: roundCents(net * rateFor(date, l.cat)) };\n  });\n" +
    "  const tax = roundCents(out.reduce((n, l) => n + l.tax, 0));\n  return { subtotal, discounted, tax, total: roundCents(discounted + tax), lines: out };\n}\n",
  "src/index.js":
    'export { roundCents } from "./round.js";\nexport { rateFor } from "./rates.js";\nexport { applyDiscounts } from "./discount.js";\nexport { allocate } from "./allocate.js";\nexport { buildInvoice } from "./invoice.js";\n',
};
const INV_GOLDEN_JS = `// golden 用例：fixtures/golden/*.json 里每个 { input, expected } 都要逐字段相等
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildInvoice } from "../src/index.js";

const dir = new URL("../fixtures/golden/", import.meta.url);
let bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const { input, expected } = JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
  try {
    assert.deepEqual(buildInvoice(input), expected);
    console.log(\`ok   \${f}\`);
  } catch (e) {
    bad++;
    console.log(\`FAIL \${f}\\n\${e.message}\\n\`);
  }
}
if (bad) {
  console.log(\`golden: \${bad} failed\`);
  process.exit(1);
}
console.log("golden: all passed");
`;
const INV_TESTS: Record<string, string> = {
  "test/round.test.js":
    T_HEAD + 'import { roundCents } from "../src/index.js";\n\n' +
    'test("rounds half up to cents", () => {\n  assert.equal(roundCents(1.005), 1.01);\n  assert.equal(roundCents(2.675), 2.68);\n  assert.equal(roundCents(0.1 + 0.2), 0.3);\n});\n\n' +
    'test("negative amounts round symmetrically", () => {\n  assert.equal(roundCents(-1.005), -1.01);\n  assert.equal(roundCents(-2.5), -2.5);\n});\n',
  "test/discount.test.js":
    T_HEAD + 'import { applyDiscounts } from "../src/index.js";\n\n' +
    'test("coupon first, then percent", () => {\n  assert.equal(applyDiscounts(100, { coupon: 10, percent: 20 }), 72);\n});\n\n' +
    'test("no discount", () => {\n  assert.equal(applyDiscounts(50), 50);\n});\n',
  "test/rates.test.js":
    T_HEAD + 'import { rateFor } from "../src/index.js";\n\n' +
    'test("standard rate in effect", () => {\n  assert.equal(rateFor("2023-05-01"), 0.08);\n  assert.equal(rateFor("2025-03-01"), 0.09);\n});\n\n' +
    'test("effective date is inclusive", () => {\n  assert.equal(rateFor("2022-01-01"), 0.08);\n});\n\n' +
    'test("reduced rate", () => {\n  assert.equal(rateFor("2023-05-01", "reduced"), 0.05);\n});\n',
  "test/invoice.test.js":
    T_HEAD + 'import { buildInvoice } from "../src/index.js";\n\n' +
    'test("single line invoice totals", () => {\n  const inv = buildInvoice({ date: "2024-07-01", lines: [{ price: 19.99, qty: 3 }], coupon: 5, percent: 10 });\n' +
    "  assert.deepEqual([inv.subtotal, inv.discounted, inv.tax, inv.total], [59.97, 49.47, 4.45, 53.92]);\n});\n",
};
const INV_FIXED: Record<string, string> = {
  "src/round.js":
    "// 金额舍入到分：按绝对值四舍五入（负数对称）；先按 15 位有效数字规整，消掉 1.005 * 100 = 100.49999… 这类浮点误差\n" +
    "export function roundCents(x) {\n  const cents = Math.round(Number((Math.abs(x) * 100).toPrecision(15)));\n  return (Math.sign(x) * cents) / 100;\n}\n",
  "src/rates.js":
    'import standard from "../data/rates.json" with { type: "json" };\nimport reduced from "../data/rates-reduced.json" with { type: "json" };\n\nconst TABLES = { standard, reduced };\n\n' +
    "// 按开票日期（YYYY-MM-DD）与税类取生效的税率：effective 当天起生效；表不保证有序\nexport function rateFor(date, category = \"standard\") {\n" +
    "  const table = TABLES[category] ?? standard;\n  let best = null;\n  for (const r of table) if (r.effective <= date && (!best || r.effective > best.effective)) best = r;\n  return (best ?? table[0]).rate;\n}\n",
  "src/discount.js":
    'import { roundCents } from "./round.js";\n\n// 先减券（coupon，元），再打折（percent，0–100）；不低于 0\nexport function applyDiscounts(subtotal, { coupon = 0, percent = 0 } = {}) {\n' +
    "  const afterCoupon = Math.max(0, subtotal - coupon);\n  return roundCents(afterCoupon * (1 - percent / 100));\n}\n",
  "src/allocate.js":
    'import { roundCents } from "./round.js";\n\n// 把订单折扣 total 按各行金额比例分摊到各行（每行舍入到分），尾差计入金额最大的一行（并列取最靠前的）；小计为 0 不分摊\n' +
    "export function allocate(total, amounts) {\n  const sum = amounts.reduce((n, a) => n + a, 0);\n  if (!sum) return amounts.map(() => 0);\n" +
    "  const shares = amounts.map((a) => roundCents((total * a) / sum));\n  const diff = roundCents(total - shares.reduce((n, s) => n + s, 0));\n" +
    "  let big = 0;\n  amounts.forEach((a, i) => {\n    if (a > amounts[big]) big = i;\n  });\n  shares[big] = roundCents(shares[big] + diff);\n  return shares;\n}\n",
  "src/invoice.js": INV_SRC["src/invoice.js"].replace("(l.qty || 1)", "(l.qty ?? 1)").replace("rateFor(date, l.cat)", "rateFor(date, l.category)"),
};

// 按 README 的规则算一张发票（与 INV_FIXED 同样的浮点运算顺序）；rc 可换成别的「正确」舍入实现，用来查判分对实现方式不敏感
type InvLine = { price: number; qty?: number; category?: string };
type InvInput = { date: string; lines: InvLine[]; coupon?: number; percent?: number };
const ROUNDERS: Record<string, (x: number) => number> = {
  prec15: (x) => (Math.sign(x) * Math.round(Number((Math.abs(x) * 100).toPrecision(15)))) / 100,
  prec12: (x) => (Math.sign(x) * Math.round(Number((Math.abs(x) * 100).toPrecision(12)))) / 100,
  epsilon: (x) => (Math.sign(x) * Math.round((Math.abs(x) + Number.EPSILON) * 100)) / 100,
  exp: (x) => Math.sign(x) * Number(Math.round(Number(`${Math.abs(x)}e2`)) + "e-2"),
};
function rateOf(table: Rate[], date: string): number {
  let best: Rate | null = null;
  for (const r of table) if (r.effective <= date && (!best || r.effective > best.effective)) best = r;
  return (best ?? table[0]).rate;
}
function invoiceModel(inp: InvInput, rc = ROUNDERS.prec15, tables = { standard: RATES_STD, reduced: RATES_RED }) {
  const amounts = inp.lines.map((l) => rc(l.price * (l.qty ?? 1)));
  const subtotal = rc(amounts.reduce((n, a) => n + a, 0));
  const discounted = rc(Math.max(0, subtotal - (inp.coupon ?? 0)) * (1 - (inp.percent ?? 0) / 100));
  const total = rc(subtotal - discounted);
  const sum = amounts.reduce((n, a) => n + a, 0);
  const shares = sum ? amounts.map((a) => rc((total * a) / sum)) : amounts.map(() => 0);
  if (sum) {
    const diff = rc(total - shares.reduce((n, s) => n + s, 0));
    let big = 0;
    amounts.forEach((a, i) => {
      if (a > amounts[big]) big = i;
    });
    shares[big] = rc(shares[big] + diff);
  }
  const lines = inp.lines.map((l, i) => {
    const net = rc(amounts[i] - shares[i]);
    const table = l.category === "reduced" ? tables.reduced : tables.standard;
    return { amount: amounts[i], discount: shares[i], net, tax: rc(net * rateOf(table, inp.date)) };
  });
  const tax = rc(lines.reduce((n, l) => n + l.tax, 0));
  return { subtotal, discounted, tax, total: rc(discounted + tax), lines };
}
const GOLDEN: [string, InvInput][] = [
  ["g01-basic", { date: "2023-03-15", lines: [{ price: 12.5, qty: 2 }, { price: 7.2 }] }],
  ["g02-remainder-tie", { date: "2023-03-15", lines: [{ price: 10 }, { price: 10 }, { price: 10 }], coupon: 1 }],
  ["g03-remainder-largest", { date: "2024-07-01", lines: [{ price: 50 }, { price: 20, qty: 2 }, { price: 5.5 }], percent: 15 }],
  ["g04-reduced", { date: "2023-06-01", lines: [{ price: 30, category: "reduced" }, { price: 12.99, qty: 2 }], coupon: 3 }],
  ["g05-qty", { date: "2022-08-08", lines: [{ price: 9.99, qty: 0 }, { price: 4.25 }, { price: 1.1, qty: 3 }], coupon: 2 }],
  ["g06-coupon-over", { date: "2024-01-10", lines: [{ price: 8 }, { price: 3, category: "reduced" }], coupon: 20 }],
  ["g07-all-zero", { date: "2024-01-10", lines: [{ price: 5, qty: 0 }, { price: 7, qty: 0 }], coupon: 1 }],
  ["g08-boundary", { date: "2021-01-01", lines: [{ price: 40, category: "reduced" }, { price: 60 }, { price: 25, category: "reduced" }], percent: 50 }],
];
// 审阅用例（模型看不到）：同样的规则、别的取值
const INV_HIDDEN: InvInput[] = [
  { date: "2023-03-31", lines: [{ price: 3.3 }, { price: 3.3 }, { price: 6.7 }, { price: 1.2 }], coupon: 1.5 },
  { date: "2024-06-30", lines: [{ price: 19 }, { price: 21, category: "reduced" }, { price: 21 }], percent: 10 },
  { date: "2023-04-01", lines: [{ price: 15, category: "reduced", qty: 2 }, { price: 4.5, qty: 0 }, { price: 9 }], coupon: 4, percent: 5 },
  { date: "2026-02-02", lines: [{ price: 0.5 }, { price: 0.5, qty: 0 }], coupon: 9 },
  { date: "2020-01-01", lines: [{ price: 33 }, { price: 33 }, { price: 34 }], coupon: 0.05 },
];
const ALT_STD: Rate[] = [{ effective: "2024-07-01", rate: 0.09 }, { effective: "2020-01-01", rate: 0.06 }, { effective: "2026-01-01", rate: 0.1 }, { effective: "2022-01-01", rate: 0.08 }];
const ALT_RED: Rate[] = [{ effective: "2025-05-01", rate: 0.02 }, { effective: "2020-01-01", rate: 0.03 }, { effective: "2023-04-01", rate: 0.05 }, { effective: "2021-01-01", rate: 0.04 }];
const ALT_INPUTS: InvInput[] = ["2025-12-31", "2026-01-01", "2023-01-01"].map((date) => ({ date, lines: [{ price: 10 }, { price: 10, category: "reduced" }] }));
function cascadeReview(dir: string): Record<string, boolean> {
  // 换一张更乱的税率表：src/ 与 data/ 复制到临时目录，只换两张 rates（README 第 5 条：表不保证有序）
  const tmp = tempDir("dimensio-h2a-cascade-");
  try {
    fs.cpSync(path.join(dir, "src"), path.join(tmp, "src"), { recursive: true });
    fs.cpSync(path.join(dir, "data"), path.join(tmp, "data"), { recursive: true });
    if (fs.existsSync(path.join(dir, "package.json"))) fs.copyFileSync(path.join(dir, "package.json"), path.join(tmp, "package.json"));
    fs.writeFileSync(path.join(tmp, "data", "rates.json"), JSON.stringify(ALT_STD));
    fs.writeFileSync(path.join(tmp, "data", "rates-reduced.json"), JSON.stringify(ALT_RED));
    const want = JSON.stringify(INV_HIDDEN.map((i) => invoiceModel(i)));
    const altWant = JSON.stringify(ALT_INPUTS.map((i) => invoiceModel(i, ROUNDERS.prec15, { standard: ALT_STD, reduced: ALT_RED })));
    return {
      ...reviews(dir, {
        own: `const m = await import(${url(path.join(dir, "src", "index.js"))});
await t("round:more half-up values", () => [[2.345, 2.35], [10.235, 10.24], [1.255, 1.26], [4.045, 4.05], [0.125, 0.13], [8.345, 8.35]].every(([x, y]) => m.roundCents(x) === y));
await t("round:negatives symmetric", () => [[-0.005, -0.01], [-1234.565, -1234.57], [-4.045, -4.05], [-10.235, -10.24]].every(([x, y]) => m.roundCents(x) === y));
await t("discount:not below zero", () => m.applyDiscounts(20, { coupon: 30 }) === 0 && m.applyDiscounts(20, { coupon: 30, percent: 50 }) === 0);
await t("discount:order", () => m.applyDiscounts(200, { coupon: 50, percent: 15 }) === 127.5 && m.applyDiscounts(80, { percent: 25 }) === 60);
await t("rates:boundaries", () => m.rateFor("2024-06-30") === 0.08 && m.rateFor("2024-07-01") === 0.09 && m.rateFor("2021-12-31") === 0.06 && m.rateFor("2023-03-31", "reduced") === 0.04 && m.rateFor("2023-04-01", "reduced") === 0.05);
await t("invoice:hidden cases", () => same(${JSON.stringify(INV_HIDDEN)}.map((i) => m.buildInvoice(i)), ${want}));`,
      }),
      ...reviews(tmp, {
        alt: `const a = await import(${url(path.join(tmp, "src", "index.js"))});
await t("rates:unsorted tables", () => same(${JSON.stringify(ALT_INPUTS)}.map((i) => a.buildInvoice(i)), ${altWant}));`,
      }),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const goldenFiles = () => Object.fromEntries(GOLDEN.map(([name, input]) => [`fixtures/golden/${name}.json`, JSON.stringify({ input, expected: invoiceModel(input) }, null, 2) + "\n"]));

// ═══ h2a-stack-misdirect：报错栈在渲染层，病根在 CSV 解析（CRLF、引号、字段内换行、分页重复表头） ═══

interface Sale {
  date: string;
  customer: string; // CSV 里的原样（可能带引号、转义、字段内换行）
  item: string;
  cents: number;
}
const CUSTOMERS_PLAIN = ["北辰贸易", "Smith & Sons", "Globex", "青禾餐饮", "Initech", "南山文具", "Umbrella Labs", "江北五金"];
const CUSTOMERS_TRICKY = ['"Acme, Inc."', '"The ""Best"" Shop"', '"Wayne Enterprises, Gotham"', '"王氏, 李氏联合商行"', '"青禾餐饮\n（徐汇店）"'];
const ITEMS = ["打印纸", "Widget", "Toner", "服务费", "Cable", "维修", "Desk lamp", "咖啡豆"];
const SALES_HEADER = "date,customer,item,amount";

function sales(seed: number, month: string, n: number, tricky: boolean): Sale[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const day = String(1 + Math.floor((i * 28) / n)).padStart(2, "0");
    const pool = tricky && r() < 0.35 ? CUSTOMERS_TRICKY : CUSTOMERS_PLAIN;
    const big = tricky && r() < 0.3;
    const cents = big ? 100_000 + Math.floor(r() * 400_000) : 5_000 + Math.floor(r() * 90_000);
    return { date: `${month}-${day}`, customer: pool[Math.floor(r() * pool.length)], item: ITEMS[Math.floor(r() * ITEMS.length)], cents };
  });
}
const money = (cents: number) => {
  const [i, f] = (cents / 100).toFixed(2).split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
};
// 写成 CSV：tricky 时金额 ≥ 1000 的按财务导出的习惯带千分位、加引号；pageEvery > 0 时每隔这么多行重复一次表头（系统分页导出拼起来的）
function salesCsv(rows: Sale[], eol: string, tricky: boolean, pageEvery = 0): string {
  const amount = (c: number) => (tricky && c >= 100_000 ? `"${money(c)}"` : (c / 100).toFixed(2));
  const lines = [SALES_HEADER];
  rows.forEach((s, i) => {
    if (pageEvery && i > 0 && i % pageEvery === 0) lines.push(SALES_HEADER);
    lines.push(`${s.date},${s.customer},${s.item},${amount(s.cents)}`);
  });
  return lines.join(eol) + eol;
}
const totalOf = (rows: Sale[]) => money(rows.reduce((n, s) => n + s.cents, 0));
const OCT = sales(1010, "2026-10", 42, true);
const SEP = sales(909, "2026-09", 30, false);

const RPT_SRC: Record<string, string> = {
  "scripts/report.js":
    'import fs from "node:fs";\nimport { parseCsv } from "../src/csv.js";\nimport { normalize } from "../src/normalize.js";\nimport { renderTable } from "../src/render/table.js";\n\n' +
    "// 用法：node scripts/report.js <月份 CSV>\nconst file = process.argv[2];\nconst rows = normalize(parseCsv(fs.readFileSync(file, \"utf8\")));\nconsole.log(renderTable(rows));\n",
  "src/csv.js":
    '// 极简 CSV：第一行是表头，返回 [{列名: 值}]\nexport function parseCsv(text) {\n  const lines = text.split("\\n").filter((l) => l.trim() !== "");\n  const header = lines[0].split(",");\n' +
    '  return lines.slice(1).map((line) => {\n    const cells = line.split(",");\n    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));\n  });\n}\n',
  "src/normalize.js":
    '// 金额去掉千分位转成数字\nconst parseAmount = (s) => Number(s.replace(/,/g, ""));\n\nexport function normalize(rows) {\n  return rows.map((r) => ({\n    date: r.date,\n    customer: r.customer?.trim() ?? "",\n    item: r.item,\n    amount: r.amount && parseAmount(r.amount),\n  }));\n}\n',
  "src/render/table.js":
    'const fmt = (n) => n.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");\n\n' +
    "export function renderTable(rows) {\n  const out = rows.map((r) => `${r.date}  ${r.customer.padEnd(28)} ${r.item.padEnd(10)} ${fmt(r.amount).padStart(12)}`);\n" +
    "  const total = rows.reduce((n, r) => n + r.amount, 0);\n  out.push(`合计 ${fmt(total)}`);\n  return out.join(\"\\n\");\n}\n",
  "test/table.test.js":
    T_HEAD + 'import { renderTable } from "../src/render/table.js";\n\n' +
    'test("renders rows and total", () => {\n  const out = renderTable([{ date: "2026-01-02", customer: "A", item: "x", amount: 1234.5 }, { date: "2026-01-03", customer: "B", item: "y", amount: 0.5 }]);\n' +
    '  assert.match(out, /合计 1,235\\.00$/);\n});\n',
  "test/csv.test.js": T_HEAD + 'import { parseCsv } from "../src/csv.js";\n\ntest("parses simple csv", () => {\n  assert.deepEqual(parseCsv("a,b\\n1,2\\n"), [{ a: "1", b: "2" }]);\n});\n',
  "README.md": "# 月度销售报表\n\n`node scripts/report.js data/<月份>.csv` 打印逐笔明细与合计。数据是财务系统每月导出的 CSV。\n",
};
const RPT_FIXED_CSV =
  "// RFC 4180 CSV：引号字段（字段里的逗号、换行、\"\" 转义的引号）、CRLF / LF；第一行是表头，分页导出重复出现的表头行跳过\n" +
  "function rows(text) {\n  const out = [];\n  let row = [];\n  let f = \"\";\n  let q = false;\n  for (let i = 0; i < text.length; i++) {\n    const c = text[i];\n" +
  "    if (q) {\n      if (c === '\"' && text[i + 1] === '\"') { f += '\"'; i++; }\n      else if (c === '\"') q = false;\n      else f += c;\n      continue;\n    }\n" +
  "    if (c === '\"') q = true;\n    else if (c === \",\") { row.push(f); f = \"\"; }\n    else if (c === \"\\n\") { row.push(f); out.push(row); row = []; f = \"\"; }\n" +
  "    else if (c !== \"\\r\") f += c;\n  }\n  if (f !== \"\" || row.length) { row.push(f); out.push(row); }\n  return out.filter((r) => r.some((x) => x.trim() !== \"\"));\n}\n\n" +
  "export function parseCsv(text) {\n  const [header, ...body] = rows(text.replace(/^\\uFEFF/, \"\"));\n  const key = header.join(\",\");\n" +
  "  return body.filter((cells) => cells.join(\",\") !== key).map((cells) => Object.fromEntries(header.map((h, i) => [h.trim(), cells[i]])));\n}\n";

function reportTotal(dir: string, csvAbs: string): string | null {
  const r = runNode(dir, [path.join(dir, "scripts", "report.js"), csvAbs], 20_000);
  return /^合计 (\S+)\s*$/m.exec(r.out)?.[1] ?? null;
}

// ═══ h2a-dist-needle：两百个文件的仓库，栈指向生成的 bundle，病根在 src（订单与退款两条导出） ═══════

const DOMAINS: { dir: string; label: string; n: number }[] = [
  { dir: "billing", label: "账单", n: 22 },
  { dir: "catalog", label: "商品目录", n: 22 },
  { dir: "customers", label: "客户", n: 20 },
  { dir: "delivery", label: "配送", n: 20 },
  { dir: "inventory", label: "库存", n: 18 },
  { dir: "notify", label: "通知", n: 16 },
];
function fillerModule(d: { dir: string; label: string }, i: number): string {
  const n = String(i).padStart(2, "0");
  const cap = d.dir[0].toUpperCase() + d.dir.slice(1);
  const r = rng(d.dir.length * 100 + i);
  const k = 2 + Math.floor(r() * 9);
  return [
    `// ${d.label}规则 ${n}`,
    `export function ${d.dir}Score${n}(input) {`,
    `  return Math.min(${100 + Math.floor(r() * 900)}, Math.round(Number(input?.base ?? 0) * ${k} + ${Math.floor(r() * 50)}));`,
    "}",
    `export function ${d.dir}Label${n}(entity) {`,
    `  return \`${cap.slice(0, 3).toUpperCase()}${n}-\${String(entity?.id ?? 0).padStart(6, "0")}\`;`,
    "}",
    `export const ${d.dir}Pick${n} = (list) => (list ?? []).filter((x) => x && x.active !== false).slice(0, ${k});`,
    "",
  ].join("\n");
}
const DN_CSV = `import { warn } from "./log.js";

// 导出用的 CSV 工具
export function toCsvRow(fields) {
  return fields.map((v) => (v === null || v === undefined ? "" : String(v))).join(",");
}

// 粗查一行的列数，对不上就记一条告警
export function checkRow(row, expected, ref) {
  const n = row.split(",").length;
  if (n !== expected) warn(\`csv: row field count mismatch (\${n} != \${expected}) ref=\${ref}\`);
}
`;
const DN_LOG = `// 统一日志出口（线上被采集进 logs/）
export function warn(msg) {
  console.warn(\`WARN \${msg}\`);
}
`;
const DN_ORDERS = `import { checkRow, toCsvRow } from "./csv.js";
import { warn } from "./log.js";

const HEADER = ["order_id", "date", "customer", "product", "qty", "amount"];

// 订单导出为 CSV（CRLF 换行，财务那边用 Excel 打开）
export function exportOrdersCsv(orders) {
  const lines = [toCsvRow(HEADER)];
  for (const o of orders) {
    const row = toCsvRow([o.id, o.date, o.customer, o.product, o.qty, o.amount.toFixed(2)]);
    checkRow(row, HEADER.length, o.id);
    lines.push(row);
  }
  if (!orders.length) warn("export: no orders");
  return lines.join("\\r\\n") + "\\r\\n";
}
`;
const DN_REFUNDS = `import { checkRow } from "./csv.js";

const REFUND_HEADER = "refund_id,order_id,reason,amount";

// 退款导出（财务每晚对账用）
export function exportRefundsCsv(refunds) {
  const lines = [REFUND_HEADER];
  for (const r of refunds) {
    const row = [r.id, r.orderId, r.reason, r.amount.toFixed(2)].join(",");
    checkRow(row, 4, r.id);
    lines.push(row);
  }
  return lines.join("\\r\\n") + "\\r\\n";
}
`;
const DN_BUILD = `// 把 src/ 下的模块按路径顺序拼成 dist/app.bundle.js（线上跑的是 bundle）。用法：npm run build
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = [];
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = \`\${rel}/\${e.name}\`;
    if (e.isDirectory()) walk(r);
    else if (e.name.endsWith(".js")) files.push(r);
  }
};
walk("src");
const out = ["// 自动生成：npm run build（scripts/build.js）。源码在 src/，不要手改这个文件。", ""];
const names = [];
for (const f of files) {
  out.push(\`// ---- \${f} ----\`);
  for (const line of fs.readFileSync(path.join(root, f), "utf8").replace(/\\r\\n/g, "\\n").split("\\n")) {
    if (/^import /.test(line)) continue;
    const m = /^export (?:async )?(function|const|let|class) (\\w+)/.exec(line);
    if (m) names.push(m[2]);
    out.push(line.replace(/^export /, ""));
  }
}
out.push(\`export { \${names.join(", ")} };\`, "");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "app.bundle.js"), out.join("\\n"));
console.log(\`built dist/app.bundle.js (\${files.length} modules)\`);
`;
const DN_BIN = `// 每晚的定时任务：node bin/export.js orders > exports/orders-<日期>.csv；node bin/export.js refunds > exports/refunds-<日期>.csv
import fs from "node:fs";
import { exportOrdersCsv, exportRefundsCsv } from "../dist/app.bundle.js";

const kind = process.argv[2] ?? "orders";
const data = JSON.parse(fs.readFileSync(new URL(\`../fixtures/\${kind}.json\`, import.meta.url), "utf8"));
process.stdout.write(kind === "refunds" ? exportRefundsCsv(data) : exportOrdersCsv(data));
`;
const DN_SMOKE = `// 冒烟：用 dist 里的 bundle（也就是线上跑的那份）导出两条订单，照 Excel 打开时的读法解析回来逐列比对；导出过程中不该有 csv 告警
import { exportOrdersCsv } from "../dist/app.bundle.js";

${RFC_PARSE_JS.replace("function rfcParse(", "function parseCsv(")}
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(" ")); origWarn(...a); };
const orders = [
  { id: 1, date: "2026-11-01", customer: "Acme, Inc.", product: "Cable, 2m", qty: 2, amount: 19.9 },
  { id: 2, date: "2026-11-01", customer: "王五", product: "USB-C 扩展坞", qty: 1, amount: 299 },
];
const rows = parseCsv(exportOrdersCsv(orders));
const want = [["order_id", "date", "customer", "product", "qty", "amount"], ...orders.map((o) => [String(o.id), o.date, o.customer, o.product, String(o.qty), o.amount.toFixed(2)])];
const bad = want.findIndex((w, i) => JSON.stringify(rows[i]) !== JSON.stringify(w));
if (bad >= 0 || rows.length !== want.length) {
  console.log(\`smoke FAIL: row \${bad} = \${JSON.stringify(rows[bad])}\`);
  process.exit(1);
}
const csvWarn = warnings.filter((w) => w.includes("csv:"));
if (csvWarn.length) {
  console.log(\`smoke FAIL: \${csvWarn.length} csv warning(s)\`);
  process.exit(1);
}
console.log("smoke OK");
`;
const DN_ORDERS_JSON = JSON.stringify(
  [
    { id: 10480, date: "2026-11-05", customer: "北辰贸易", product: "打印纸 A4", qty: 10, amount: 259 },
    { id: 10481, date: "2026-11-05", customer: "Globex", product: "Toner", qty: 2, amount: 640.5 },
    { id: 10482, date: "2026-11-05", customer: "Smith & Sons", product: "Desk lamp, black", qty: 1, amount: 89.99 },
    { id: 10483, date: "2026-11-06", customer: "Initech", product: 'Monitor 27" 4K', qty: 3, amount: 5397 },
  ],
  null,
  2,
);
const DN_REFUNDS_JSON = JSON.stringify(
  [
    { id: "R-310", orderId: 10377, reason: "破损", amount: 59 },
    { id: "R-311", orderId: 10402, reason: "尺码不对, 客户要换货", amount: 120 },
    { id: "R-312", orderId: 10455, reason: '包装上写着"易碎"仍被压坏', amount: 35.5 },
  ],
  null,
  2,
);
const DN_TESTS: Record<string, string> = {
  "test/export.test.js": T_HEAD + 'import { toCsvRow } from "../src/export/csv.js";\n\ntest("plain row", () => {\n  assert.equal(toCsvRow([1, "a", null, 2.5]), "1,a,,2.5");\n});\n',
  "test/billing.test.js": T_HEAD + 'import { billingLabel03 } from "../src/billing/rule03.js";\n\ntest("billing 03", () => {\n  assert.match(billingLabel03({ id: 7 }), /^BIL03-000007$/);\n});\n',
  "test/notify.test.js": T_HEAD + 'import { notifyPick05 } from "../src/notify/rule05.js";\n\ntest("notify 05", () => {\n  assert.deepEqual(notifyPick05([{ id: 1 }, null, { id: 2, active: false }]), [{ id: 1 }]);\n});\n',
};
const DN_README = `# orders-service

订单后台。src/ 是源码；线上跑的是打包后的 dist/app.bundle.js（\`npm run build\` 生成）。

- 每晚导出：\`node bin/export.js orders\`、\`node bin/export.js refunds\`
- 测试：\`npm test\`
- 冒烟：\`node scripts/smoke.js\`
`;
function dnLog(bundle: string): string {
  const lines = bundle.split("\n");
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
  const checkLine = at("if (n !== expected) warn(");
  const orderCall = at("checkRow(row, HEADER.length, o.id);");
  const refundCall = at("checkRow(row, 4, r.id);");
  const out: string[] = [];
  const r = rng(4242);
  const paths = ["/api/orders", "/api/catalog", "/api/customers/:id", "/api/export", "/healthz", "/api/inventory"];
  for (let i = 0; i < 700; i++) {
    const ts = `2026-11-06T${String(Math.floor(i / 30)).padStart(2, "0")}:${String(Math.floor((i % 30) * 2)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    const p = paths[Math.floor(r() * paths.length)];
    const x = r();
    if (x < 0.02) out.push(`${ts} ERROR redis: connection reset by peer (ECONNRESET) — retrying in 200ms`);
    else if (x < 0.04) out.push(`${ts} WARN deprecated: catalog.legacyPrice() will be removed in v5`);
    else if (x < 0.05) out.push(`${ts} WARN slow request GET /api/export took ${2000 + Math.floor(r() * 3000)}ms`);
    else out.push(`${ts} INFO ${p} 200 ${Math.floor(r() * 120)}ms`);
    if (i === 430) {
      out.push(`${ts} INFO export: nightly job started (orders)`);
      out.push(`${ts} WARN csv: row field count mismatch (7 != 6) ref=10482`);
      out.push(`    at checkRow (file:///srv/orders-service/dist/app.bundle.js:${checkLine}:20)`);
      out.push(`    at exportOrdersCsv (file:///srv/orders-service/dist/app.bundle.js:${orderCall}:5)`);
      out.push(`    at file:///srv/orders-service/bin/export.js:7:52`);
      out.push(`${ts} INFO export: nightly job started (refunds)`);
      out.push(`${ts} WARN csv: row field count mismatch (5 != 4) ref=R-311`);
      out.push(`    at checkRow (file:///srv/orders-service/dist/app.bundle.js:${checkLine}:20)`);
      out.push(`    at exportRefundsCsv (file:///srv/orders-service/dist/app.bundle.js:${refundCall}:5)`);
      out.push(`    at file:///srv/orders-service/bin/export.js:7:28`);
      out.push(`${ts} INFO export: nightly job finished`);
    }
  }
  return out.join("\n") + "\n";
}
const dnBuild = (dir: string) => runNode(dir, [path.join(dir, "scripts", "build.js")]);
const DN_FIXED_CSV = `import { warn } from "./log.js";

// 导出用的 CSV 工具（RFC 4180：含逗号、引号、换行的字段加引号，引号写成两个）
export function toCsvRow(fields) {
  return fields
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\\r\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;
    })
    .join(",");
}

// 按 RFC 4180 数一行的列数（引号里的逗号不算），对不上就记一条告警
export function checkRow(row, expected, ref) {
  let n = 1;
  let q = false;
  for (const c of row) {
    if (c === '"') q = !q;
    else if (c === "," && !q) n++;
  }
  if (n !== expected) warn(\`csv: row field count mismatch (\${n} != \${expected}) ref=\${ref}\`);
}
`;
const DN_FIXED_REFUNDS = DN_REFUNDS.replace('import { checkRow } from "./csv.js";', 'import { checkRow, toCsvRow } from "./csv.js";').replace(
  "const row = [r.id, r.orderId, r.reason, r.amount.toFixed(2)].join(\",\");",
  "const row = toCsvRow([r.id, r.orderId, r.reason, r.amount.toFixed(2)]);",
);
const DN_TRICKY_ORDERS = `[
  { id: 7, date: "2026-11-07", customer: "Acme, Inc.", product: 'Monitor 27" 4K', qty: 1, amount: 1799 },
  { id: 8, date: "2026-11-07", customer: 'The "Best" Shop', product: "a,b,c", qty: 12, amount: 0.5 },
  { id: 9, date: "2026-11-07", customer: "多行\\n备注", product: "x\\r\\ny", qty: 3, amount: 10 },
  { id: 10, date: "2026-11-07", customer: "plain", product: "plain", qty: 0, amount: 0 },
]`;
const DN_TRICKY_REFUNDS = `[
  { id: "R-1", orderId: 7, reason: "坏了, 要退", amount: 12 },
  { id: "R-2", orderId: 8, reason: '说是"全新"其实是旧的', amount: 3.5 },
  { id: "R-3", orderId: 9, reason: "第一行\\n第二行", amount: 1 },
  { id: "R-4", orderId: 10, reason: "plain", amount: 0 },
]`;
function distNeedleReview(dir: string): Record<string, boolean> {
  const wantO = `[["order_id", "date", "customer", "product", "qty", "amount"], ...O.map((o) => [String(o.id), o.date, o.customer, o.product, String(o.qty), o.amount.toFixed(2)])]`;
  const wantR = `[["refund_id", "order_id", "reason", "amount"], ...F.map((r) => [r.id, String(r.orderId), r.reason, r.amount.toFixed(2)])]`;
  const head = `${RFC_PARSE_JS}\nconst O = ${DN_TRICKY_ORDERS};\nconst F = ${DN_TRICKY_REFUNDS};\nconst W = []; console.warn = (...a) => W.push(a.join(" "));\n`;
  const exportsOf = (label: string, ordersMod: string, refundsMod: string) => `
await t("${label} orders", async () => { const m = await import(${ordersMod}); return same(rfcParse(m.exportOrdersCsv(O)), ${wantO}); });
await t("${label} refunds", async () => { const m = await import(${refundsMod}); return same(rfcParse(m.exportRefundsCsv(F)), ${wantR}); });
await t("${label} no csv warnings on valid rows", () => !W.some((w) => w.includes("csv:")));`;
  const bundle = url(path.join(dir, "dist/app.bundle.js"));
  return reviews(dir, {
    src:
      head +
      `await t("src toCsvRow escapes", async () => {
  const m = await import(${url(path.join(dir, "src/export/csv.js"))});
  return same(rfcParse(m.toCsvRow(["a,b", 'say "hi"', "two\\nlines", "plain", 3, null, undefined, "", " sp "]) + "\\r\\n"), [["a,b", 'say "hi"', "two\\nlines", "plain", "3", "", "", "", " sp "]]);
});` +
      exportsOf("src", url(path.join(dir, "src/export/orders.js")), url(path.join(dir, "src/export/refunds.js"))) +
      `
await t("src checkRow still flags a broken row", async () => { const m = await import(${url(path.join(dir, "src/export/csv.js"))}); W.length = 0; m.checkRow("1,2,3,4,5,6,7", 6, "x"); return W.some((w) => w.includes("csv:")); });`,
    dist: head + exportsOf("dist", bundle, bundle),
  });
}

// ═══ h2a-split-utils：工具库拆四个模块，公开 API 不变（共享流水号、跨模块活绑定、别名、默认导出） ═══

const UTILS_SRC = `// 通用工具函数（越堆越长了）。别的包都从这里 import，公开 API 不能变。

const MS_PER_DAY = 86_400_000;
// 流水号
let seq = 0;

// 内部：把连续空白压成一个空格并去掉首尾
function squash(s) {
  return String(s ?? "").replace(/\\s+/g, " ").trim();
}

// 内部：两位补零
function pad2(n) {
  return String(n).padStart(2, "0");
}

// ── 字符串 ─────────────────────────────────────────────

// 千分位分隔符
export let defaultSeparator = ",";

export function setDefaultSeparator(s) {
  defaultSeparator = s;
}

export function capitalize(s) {
  const t = String(s ?? "");
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
}

export function titleCase(s) {
  return squash(s).split(" ").map(capitalize).join(" ");
}

export function kebabCase(s) {
  return squash(String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_]+/g, " "))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function truncate(s, n, tail = "…") {
  const t = String(s);
  return t.length > n ? t.slice(0, Math.max(0, n - tail.length)) + tail : t;
}

export function countWords(s) {
  const t = squash(s);
  return t ? t.split(" ").length : 0;
}

// 自然排序比较：file2 < file10
export function compareNatural(a, b) {
  const re = /(\\d+)|(\\D+)/g;
  const xa = String(a).match(re) ?? [];
  const xb = String(b).match(re) ?? [];
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    if (p === q) continue;
    if (/^\\d/.test(p) && /^\\d/.test(q)) return Number(p) - Number(q);
    return p < q ? -1 : 1;
  }
  return xa.length - xb.length;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function stripTags(s) {
  return squash(String(s).replace(/<[^>]*>/g, " "));
}

export function uniqueId(prefix = "id") {
  seq += 1;
  return \`\${prefix}_\${seq}\`;
}

// ── 数组 ─────────────────────────────────────────────

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function groupBy(arr, fn) {
  const out = {};
  for (const x of arr) (out[fn(x)] ??= []).push(x);
  return out;
}

export function partition(arr, pred) {
  const yes = [];
  const no = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}

export function sortNatural(arr) {
  return [...arr].sort(compareNatural);
}

// 求和后保留 10 位小数，消掉 0.1 + 0.2 这类误差
export function sumBy(arr, fn = (x) => x) {
  return roundTo(arr.reduce((n, x) => n + fn(x), 0), 10);
}

export function range(start, end, step = 1) {
  const out = [];
  for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
  return out;
}

export function last(arr, n = 1) {
  return n === 1 ? arr[arr.length - 1] : arr.slice(-n);
}

// ── 日期 ─────────────────────────────────────────────

// "2026-03-05"（前后空白容忍）→ UTC 零点的 Date
export function parseDate(s) {
  const [y, m, d] = squash(s).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d) {
  return \`\${d.getUTCFullYear()}-\${pad2(d.getUTCMonth() + 1)}-\${pad2(d.getUTCDate())}\`;
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

export function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

export function isWeekend(d) {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

export function endOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// 秒数 → hh:mm:ss
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return \`\${pad2(Math.floor(s / 3600))}:\${pad2(Math.floor((s % 3600) / 60))}:\${pad2(s % 60)}\`;
}

export function businessDaysBetween(a, b) {
  let n = 0;
  for (let d = a; d < b; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

// ── 数字 ─────────────────────────────────────────────

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function roundTo(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return \`\${roundTo(v, 1)} \${units[i]}\`;
}

export function formatThousands(n) {
  const [i, f] = String(n).split(".");
  return i.replace(/\\B(?=(\\d{3})+(?!\\d))/g, defaultSeparator) + (f ? \`.\${f}\` : "");
}

export function percent(part, total, digits = 1) {
  return total ? \`\${roundTo((part / total) * 100, digits)}%\` : "0%";
}

export function average(arr) {
  return arr.length ? sumBy(arr) / arr.length : 0;
}

// 毫秒 → "2d 03:04:05"（不足一天不写天数）
export function formatDuration(ms) {
  const days = Math.floor(ms / MS_PER_DAY);
  const rest = Math.floor((ms % MS_PER_DAY) / 1000);
  const hms = \`\${pad2(Math.floor(rest / 3600))}:\${pad2(Math.floor((rest % 3600) / 60))}:\${pad2(rest % 60)}\`;
  return days ? \`\${days}d \${hms}\` : hms;
}

// 工单号：T-0001 起
export function nextTicket() {
  seq += 1;
  return \`T-\${String(seq).padStart(4, "0")}\`;
}

// 旧名字，别的包还在用
export { chunk as splitEvery, kebabCase as slugify };

export default { capitalize, chunk, parseDate, formatDate, clamp, roundTo, uniqueId, nextTicket };
`;
const UTILS_GROUPS: Record<string, string[]> = {
  string: ["setDefaultSeparator", "capitalize", "titleCase", "kebabCase", "truncate", "countWords", "compareNatural", "escapeHtml", "stripTags", "uniqueId"],
  array: ["chunk", "uniq", "groupBy", "partition", "sortNatural", "sumBy", "range", "last"],
  date: ["parseDate", "formatDate", "addDays", "diffDays", "isWeekend", "endOfMonth", "formatTime", "businessDaysBetween"],
  number: ["clamp", "roundTo", "formatBytes", "formatThousands", "percent", "average", "formatDuration", "nextTicket"],
};
// src/app 下的业务模块（各自从 ../utils.js 引几个函数；有用别名的、有用默认导出的）
const UTILS_APP: Record<string, string> = {
  "src/app/users.js": 'import { titleCase, kebabCase, uniqueId } from "../utils.js";\n\nexport function makeUser(name) {\n  return { id: uniqueId("user"), name: titleCase(name), handle: kebabCase(name) };\n}\n',
  "src/app/pager.js": 'import { splitEvery, clamp } from "../utils.js";\n\nexport function page(items, size, n) {\n  const pages = splitEvery(items, size);\n  return pages[clamp(n, 0, Math.max(0, pages.length - 1))] ?? [];\n}\n',
  "src/app/invoice-date.js":
    'import { parseDate, addDays, formatDate, isWeekend } from "../utils.js";\n\n// 到期日：开票日 + 账期，落在周末顺延到周一\nexport function dueDate(issued, termDays) {\n  let d = addDays(parseDate(issued), termDays);\n  while (isWeekend(d)) d = addDays(d, 1);\n  return formatDate(d);\n}\n',
  "src/app/report.js":
    'import { groupBy, sumBy, formatThousands, percent } from "../utils.js";\n\nexport function regionReport(rows) {\n  const total = sumBy(rows, (r) => r.amount);\n  const by = groupBy(rows, (r) => r.region);\n' +
    "  return Object.keys(by).sort().map((k) => ({ region: k, amount: formatThousands(sumBy(by[k], (r) => r.amount)), share: percent(sumBy(by[k], (r) => r.amount), total) }));\n}\n",
  "src/app/files.js": 'import { sortNatural, formatBytes } from "../utils.js";\n\nexport function listing(files) {\n  return sortNatural(files.map((f) => f.name)).map((n) => `${n} ${formatBytes(files.find((f) => f.name === n).size)}`);\n}\n',
  "src/app/slug.js": 'import { slugify, truncate } from "../utils.js";\n\nexport function articleSlug(title) {\n  return truncate(slugify(title), 40, "");\n}\n',
  "src/app/stats.js": 'import { average, roundTo } from "../utils.js";\n\nexport function summary(xs) {\n  return { avg: roundTo(average(xs), 2), n: xs.length };\n}\n',
  "src/app/timesheet.js":
    'import { formatTime, diffDays, businessDaysBetween, parseDate } from "../utils.js";\n\nexport function timesheet(from, to, seconds) {\n  const a = parseDate(from);\n  const b = parseDate(to);\n' +
    "  return { days: diffDays(a, b), workdays: businessDaysBetween(a, b), logged: formatTime(seconds) };\n}\n",
  "src/app/legacy.js":
    'import utils from "../utils.js";\n\n// 老代码：经默认导出用\nexport function legacyCard(name, born) {\n  return `${utils.capitalize(name)} (${utils.formatDate(utils.parseDate(born))}) #${utils.clamp(name.length, 1, 9)} ${utils.nextTicket()}`;\n}\n',
  "src/app/tickets.js": 'import { nextTicket, endOfMonth, formatDate } from "../utils.js";\n\nexport function openTicket(title, d) {\n  return { no: nextTicket(), title, due: formatDate(endOfMonth(d)) };\n}\n',
};
const UTILS_TESTS: Record<string, string> = {
  "test/utils.test.js":
    T_HEAD + 'import * as u from "../src/utils.js";\nimport utils from "../src/utils.js";\n\n' +
    'test("strings", () => {\n  assert.equal(u.capitalize("hELLO"), "Hello");\n  assert.equal(u.titleCase("  the  quick fox "), "The Quick Fox");\n  assert.equal(u.kebabCase("Hello World_x"), "hello-world-x");\n  assert.equal(u.truncate("abcdef", 4), "abc…");\n  assert.equal(u.escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");\n});\n\n' +
    'test("arrays", () => {\n  assert.deepEqual(u.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n  assert.deepEqual(u.uniq([1, 1, 2]), [1, 2]);\n  assert.equal(u.sumBy([0.1, 0.2]), 0.3);\n});\n\n' +
    'test("dates", () => {\n  const d = u.parseDate("2026-03-05");\n  assert.equal(u.formatDate(u.addDays(d, 30)), "2026-04-04");\n  assert.equal(u.isWeekend(u.parseDate("2026-03-07")), true);\n});\n\n' +
    'test("numbers", () => {\n  assert.equal(u.clamp(15, 0, 10), 10);\n  assert.equal(u.formatBytes(1536), "1.5 KB");\n  assert.equal(u.formatThousands(1234567), "1,234,567");\n});\n\n' +
    'test("default export and aliases", () => {\n  assert.equal(utils.capitalize("x"), "X");\n  assert.deepEqual(u.splitEvery([1, 2, 3], 2), [[1, 2], [3]]);\n});\n',
  "test/app.test.js":
    T_HEAD + 'import { dueDate } from "../src/app/invoice-date.js";\nimport { page } from "../src/app/pager.js";\nimport { articleSlug } from "../src/app/slug.js";\nimport { regionReport } from "../src/app/report.js";\n\n' +
    'test("due date skips weekend", () => {\n  assert.equal(dueDate("2026-03-02", 5), "2026-03-09");\n});\n\n' +
    'test("pager", () => {\n  assert.deepEqual(page([1, 2, 3, 4, 5], 2, 9), [5]);\n});\n\n' +
    'test("slug", () => {\n  assert.equal(articleSlug("Hello World"), "hello-world");\n});\n\n' +
    'test("report", () => {\n  assert.deepEqual(regionReport([{ region: "e", amount: 1500 }, { region: "w", amount: 500 }]), [{ region: "e", amount: "1,500", share: "75%" }, { region: "w", amount: "500", share: "25%" }]);\n});\n',
};
// 审阅样例：每个公开函数的几组调用（覆盖到每个函数的私有依赖：squash / pad2 / MS_PER_DAY / 跨分节调用）
const UTILS_SAMPLES = `() => ({
  capitalize: [["hELLO"], [""], ["é"]],
  titleCase: [["  the  quick\\tfox "], ["a"]],
  kebabCase: [["helloWorld Again"], ["A__B  c"]],
  slugify: [["Hello World 2026!"], ["fooBar"]],
  truncate: [["abcdefgh", 5], ["ab", 5], ["abcdef", 4, "..."]],
  countWords: [["  one two   three "], ["   "]],
  compareNatural: [["file2", "file10"], ["b", "a"], ["x1y2", "x1y2"]],
  escapeHtml: [["<p class=\\"a\\">'&'</p>"]],
  stripTags: [["<b>hi</b>   <i>there</i>"]],
  uniqueId: [["order"], []],
  chunk: [[[1, 2, 3, 4, 5, 6, 7], 3]],
  splitEvery: [[[1, 2, 3], 1]],
  uniq: [[[3, 1, 3, 2, 1]]],
  groupBy: [[[1, 2, 3, 4, 5], (x) => (x % 2 ? "odd" : "even")]],
  partition: [[[1, 2, 3, 4], (x) => x > 2]],
  sortNatural: [[["file10", "file2", "file1", "a"]]],
  sumBy: [[[0.1, 0.2, 0.3]], [[{ a: 1.1 }, { a: 2.2 }], (x) => x.a]],
  range: [[0, 5], [10, 0, -3]],
  last: [[[1, 2, 3]], [[1, 2, 3], 2]],
  parseDate: [[" 2026-03-05 "], ["2024-02-29"]],
  formatDate: [[new Date(Date.UTC(2026, 0, 9))]],
  addDays: [[new Date(Date.UTC(2026, 1, 27)), 3]],
  diffDays: [[new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 2, 1))]],
  isWeekend: [[new Date(Date.UTC(2026, 2, 8))], [new Date(Date.UTC(2026, 2, 9))]],
  endOfMonth: [[new Date(Date.UTC(2024, 1, 10))]],
  formatTime: [[3725], [-5]],
  businessDaysBetween: [[new Date(Date.UTC(2026, 2, 6)), new Date(Date.UTC(2026, 2, 17))]],
  clamp: [[-1, 0, 5], [3, 0, 5]],
  roundTo: [[1.005, 2], [123.456, 1]],
  formatBytes: [[512], [5 * 1024 ** 3]],
  formatThousands: [[1234567.891], [999]],
  percent: [[1, 3], [5, 0], [2, 7, 3]],
  average: [[[0.1, 0.2, 0.3]], [[]]],
  formatDuration: [[93784000], [5000]],
  nextTicket: [[], []],
})`;
const UTILS_APP_SAMPLES = `[
  ["users.js", "makeUser", [["  ada   lovelace "]]],
  ["pager.js", "page", [[[1, 2, 3, 4, 5], 2, 1], [[1, 2, 3], 5, -2]]],
  ["invoice-date.js", "dueDate", [["2026-03-04", 3], ["2026-02-27", 1]]],
  ["report.js", "regionReport", [[[{ region: "n", amount: 1234.5 }, { region: "s", amount: 0.5 }, { region: "n", amount: 1 }]]]],
  ["files.js", "listing", [[[{ name: "img10.png", size: 2048 }, { name: "img2.png", size: 10 }]]]],
  ["slug.js", "articleSlug", [["A Very Long Title That Keeps Going On And On Forever"]]],
  ["stats.js", "summary", [[[1, 2, 3, 10]]]],
  ["timesheet.js", "timesheet", [["2026-03-02", "2026-03-16", 30000]]],
  ["legacy.js", "legacyCard", [["aDA", " 1815-12-10 "]]],
  ["tickets.js", "openTicket", [["printer jam", new Date(Date.UTC(2026, 1, 3))]]],
]`;
// 去掉 JS 注释再查：入口「只剩再导出」、业务代码「不再经旧入口」都不该被注释里的 function / => / 旧 import 误判
// （这些文件里正常不会有含 // 或 /* 的字符串）
const stripJsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
// utils.js 被谁 import：相对路径落到 src/utils.js 本身（./utils.js、../utils.js、../utils），落到 ./utils/xxx.js 的不算
const IMPORTS_UTILS_JS = /from\s*["'](?:\.\.?\/)+utils(?:\.js)?["']|import\s*\(\s*["'](?:\.\.?\/)+utils(?:\.js)?["']\s*\)/;
function splitUtilsReview(dir: string): Record<string, boolean> {
  const orig = tempDir("dimensio-h2a-utils-orig-");
  try {
    write(orig, "package.json", pkgJson);
    write(orig, "src/utils.js", UTILS_SRC);
    for (const [rel, text] of Object.entries(UTILS_APP)) write(orig, rel, text);
    const head = `const O = await import(${url(path.join(orig, "src/utils.js"))});
const N = await import(${url(path.join(dir, "src/utils.js"))});
const call = (fn, args) => { try { return canon({ v: fn(...args) }); } catch (e) { return "throw:" + (e && e.constructor && e.constructor.name); } };
`;
    const appDirO = JSON.stringify(pathToFileURL(path.join(orig, "src/app")).href);
    const appDirN = JSON.stringify(pathToFileURL(path.join(dir, "src/app")).href);
    return reviews(dir, {
      api:
        head +
        `const S = ${UTILS_SAMPLES};
const so = S(); const sn = S();
await t("api:every export kept", () => Object.keys(O).every((k) => k in N));
for (const name of Object.keys(so)) await t("same:" + name, () => so[name].every((args, i) => typeof N[name] === "function" && call(O[name], args) === call(N[name], sn[name][i])));
await t("api:default export keys", () => same(Object.keys(O.default).sort(), Object.keys(N.default ?? {}).sort()));
const so2 = S(); const sn2 = S();
await t("api:default export behaves", () => Object.keys(O.default).every((k) => so2[k].every((args, i) => call(O.default[k], args) === call(N.default[k], sn2[k][i]))));
const G = ${JSON.stringify(UTILS_GROUPS)};
for (const [g, names] of Object.entries(G)) await t("module:" + g, async () => { const m = await import(${JSON.stringify(pathToFileURL(path.join(dir, "src/utils")).href)} + "/" + g + ".js"); return names.every((n) => typeof m[n] === "function"); });`,
      // 共享流水号：两个函数穿插着调，序列要与原版一致
      seq: head + `await t("state:shared sequence", () => { const a = [O.uniqueId("a"), O.nextTicket(), O.uniqueId(), O.default.nextTicket(), O.default.uniqueId("z")]; const b = [N.uniqueId("a"), N.nextTicket(), N.uniqueId(), N.default.nextTicket(), N.default.uniqueId("z")]; return same(a, b); });`,
      // 活绑定：经兼容入口改分隔符，数字模块要跟着变，入口上读到的也要是新值
      live:
        head +
        `await t("state:live separator binding", () => { N.setDefaultSeparator(" "); const ok = N.formatThousands(1234567) === "1 234 567" && N.defaultSeparator === " "; N.setDefaultSeparator(","); return ok && N.formatThousands(1234) === "1,234" && N.defaultSeparator === ","; });`,
      app:
        head +
        `for (const [file, fn, cases] of ${UTILS_APP_SAMPLES}) await t("app:" + file, async () => {
  const a = await import(${appDirO} + "/" + file);
  const b = await import(${appDirN} + "/" + file);
  return cases.every((args) => call(a[fn], structuredClone(args)) === call(b[fn], structuredClone(args)));
});`,
    });
  } finally {
    fs.rmSync(orig, { recursive: true, force: true });
  }
}
const UTILS_FIXED = (() => {
  // 参考解：私有依赖与共享流水号放进 src/utils/_shared.js，四个分节各一个模块，utils.js 只再导出
  const body = UTILS_SRC.split("\n");
  const sectionOf = (title: string) => {
    const start = body.findIndex((l) => l.startsWith(`// ── ${title}`));
    let end = body.findIndex((l, i) => i > start && (l.startsWith("// ── ") || l.startsWith("// 旧名字")));
    if (end < 0) end = body.length;
    return body.slice(start + 1, end).join("\n").trim() + "\n";
  };
  const shared =
    "export const MS_PER_DAY = 86_400_000;\n\n// uniqueId 与 nextTicket 共用的流水号\nlet seq = 0;\nexport function nextSeq() {\n  seq += 1;\n  return seq;\n}\n\n" +
    "export function squash(s) {\n  return String(s ?? \"\").replace(/\\s+/g, \" \").trim();\n}\n\nexport function pad2(n) {\n  return String(n).padStart(2, \"0\");\n}\n";
  const str = 'import { nextSeq, squash } from "./_shared.js";\n\n' + sectionOf("字符串").replace("  seq += 1;\n  return `${prefix}_${seq}`;", "  return `${prefix}_${nextSeq()}`;");
  const arr = 'import { compareNatural } from "./string.js";\nimport { roundTo } from "./number.js";\n\n' + sectionOf("数组");
  const date = 'import { MS_PER_DAY, pad2, squash } from "./_shared.js";\n\n' + sectionOf("日期");
  const num =
    'import { MS_PER_DAY, nextSeq, pad2 } from "./_shared.js";\nimport { sumBy } from "./array.js";\nimport { defaultSeparator } from "./string.js";\n\n' +
    sectionOf("数字").replace("  seq += 1;\n  return `T-${String(seq).padStart(4, \"0\")}`;", '  return `T-${String(nextSeq()).padStart(4, "0")}`;');
  const groups = Object.entries(UTILS_GROUPS);
  const entry =
    "// 兼容入口：实现拆到 src/utils/ 下，这里只再导出\n" +
    groups.map(([g]) => `export * from "./utils/${g}.js";`).join("\n") +
    '\nexport { chunk as splitEvery } from "./utils/array.js";\nexport { kebabCase as slugify } from "./utils/string.js";\n\n' +
    'import { capitalize, uniqueId } from "./utils/string.js";\nimport { chunk } from "./utils/array.js";\nimport { parseDate, formatDate } from "./utils/date.js";\nimport { clamp, roundTo, nextTicket } from "./utils/number.js";\n\n' +
    "export default { capitalize, chunk, parseDate, formatDate, clamp, roundTo, uniqueId, nextTicket };\n";
  const owner = new Map(groups.flatMap(([g, names]) => names.map((n) => [n, g] as const)));
  const app = Object.fromEntries(
    Object.entries(UTILS_APP).map(([rel, text]) => {
      let t = text;
      const named = /import \{ ([^}]+) \} from "\.\.\/utils\.js";/.exec(t);
      if (named) {
        const per = new Map<string, string[]>();
        for (const n of named[1].split(",").map((s) => s.trim())) {
          const base = n === "splitEvery" ? "chunk" : n === "slugify" ? "kebabCase" : n;
          const g = owner.get(base)!;
          per.set(g, [...(per.get(g) ?? []), base === n ? n : `${base} as ${n}`]);
        }
        t = t.replace(named[0], [...per].map(([g, ns]) => `import { ${ns.join(", ")} } from "../utils/${g}.js";`).join("\n"));
      } else {
        t = t
          .replace('import utils from "../utils.js";', 'import { capitalize } from "../utils/string.js";\nimport { formatDate, parseDate } from "../utils/date.js";\nimport { clamp, nextTicket } from "../utils/number.js";')
          .replace(/utils\./g, "");
      }
      return [rel, t];
    }),
  );
  return { "src/utils/_shared.js": shared, "src/utils/string.js": str, "src/utils/array.js": arr, "src/utils/date.js": date, "src/utils/number.js": num, "src/utils.js": entry, ...app } as Record<string, string>;
})();

// ═══ h2a-perf-hotspot：12 万行的报表跑几分钟，优化到几秒且输出逐字节不变 ═══════════════════════════

const PERF_SRC: Record<string, string> = {
  "src/csv.js": `// 订单 CSV：order_id,ts,email,region,amount（第一行表头，LF 换行）
export function parseOrders(text) {
  return text
    .split("\\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const [id, ts, email, region, amount] = l.split(",");
      return { id, ts, email, region, amount: Number(amount) };
    });
}
`,
  "src/normalize.js": `// 邮箱规范化：去首尾空白、转小写；不像邮箱的原样返回（下游会单独标出来）
export function normalizeEmail(raw) {
  const re = new RegExp("^[^@\\\\s]+@[^@\\\\s]+\\\\.[a-z]{2,}$", "i");
  const e = raw.trim().toLowerCase();
  return re.test(e) ? e : raw;
}
`,
  "src/customers.js": `// 客户簿：按邮箱归并，记首次出现时的地区
export class CustomerBook {
  constructor() {
    this.list = [];
  }

  get(email, region) {
    let c = this.list.find((x) => x.email === email);
    if (!c) {
      c = { email, region, orders: 0, total: 0 };
      this.list.push(c);
    }
    return c;
  }

  // 消费额从高到低，同额按邮箱
  top(n) {
    return [...this.list].sort((a, b) => b.total - a.total || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)).slice(0, n);
  }
}
`,
  "src/window.js": `// 滑动窗口：同一客户在当前订单时间之前 ms 毫秒内（含同一时刻）已经处理过的订单数
export class RecentWindow {
  constructor(ms) {
    this.ms = ms;
    this.seen = [];
  }

  count(email, t) {
    return this.seen.filter((s) => s.email === email && s.t > t - this.ms && s.t <= t).length;
  }

  add(email, t) {
    this.seen.push({ email, t });
  }
}
`,
  "src/report.js": `import { parseOrders } from "./csv.js";
import { CustomerBook } from "./customers.js";
import { normalizeEmail } from "./normalize.js";
import { RecentWindow } from "./window.js";

const WEEK = 7 * 86_400_000;

// 逐笔：订单号、客户、近 7 天内该客户已有的订单数、该客户累计消费；末尾附消费前 20 的客户
export function buildReport(text) {
  const book = new CustomerBook();
  const win = new RecentWindow(WEEK);
  const out = ["order_id,email,recent_7d,running_total"];
  let queue = parseOrders(text);
  while (queue.length) {
    const [r, ...rest] = queue;
    queue = rest;
    if (process.env.REPORT_DEBUG) console.error(JSON.stringify(r));
    const email = normalizeEmail(r.email);
    const c = book.get(email, r.region);
    c.orders += 1;
    c.total += r.amount;
    const t = Date.parse(r.ts);
    const recent = win.count(email, t);
    win.add(email, t);
    out.push(\`\${r.id},\${email},\${recent},\${c.total}\`);
  }
  out.push("# top 20");
  for (const c of book.top(20)) out.push(\`\${c.email},\${c.region},\${c.orders},\${c.total}\`);
  return out.join("\\n") + "\\n";
}
`,
  "scripts/report.js": `// 用法：node scripts/report.js <订单 CSV> > out.txt
import fs from "node:fs";
import { buildReport } from "../src/report.js";

process.stdout.write(buildReport(fs.readFileSync(process.argv[2], "utf8")));
`,
};
const PERF_FIXED: Record<string, string> = {
  "src/normalize.js": `// 邮箱规范化：去首尾空白、转小写；不像邮箱的原样返回（下游会单独标出来）
const RE = /^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i;
export function normalizeEmail(raw) {
  const e = raw.trim().toLowerCase();
  return RE.test(e) ? e : raw;
}
`,
  "src/customers.js": `// 客户簿：按邮箱归并，记首次出现时的地区
export class CustomerBook {
  constructor() {
    this.list = [];
    this.byEmail = new Map();
  }

  get(email, region) {
    let c = this.byEmail.get(email);
    if (!c) {
      c = { email, region, orders: 0, total: 0 };
      this.list.push(c);
      this.byEmail.set(email, c);
    }
    return c;
  }

  // 消费额从高到低，同额按邮箱
  top(n) {
    return [...this.list].sort((a, b) => b.total - a.total || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)).slice(0, n);
  }
}
`,
  "src/window.js": `// 滑动窗口：同一客户在当前订单时间之前 ms 毫秒内（含同一时刻）已经处理过的订单数（按文件顺序，时间不一定递增）
export class RecentWindow {
  constructor(ms) {
    this.ms = ms;
    this.byEmail = new Map();
  }

  count(email, t) {
    const ts = this.byEmail.get(email);
    if (!ts) return 0;
    let n = 0;
    for (const s of ts) if (s > t - this.ms && s <= t) n++;
    return n;
  }

  add(email, t) {
    const ts = this.byEmail.get(email);
    if (ts) ts.push(t);
    else this.byEmail.set(email, [t]);
  }
}
`,
  "src/report.js": PERF_SRC["src/report.js"].replace("  let queue = parseOrders(text);\n  while (queue.length) {\n    const [r, ...rest] = queue;\n    queue = rest;\n", "  for (const r of parseOrders(text)) {\n"),
};
// 订单数据：时间大体递增，outOfOrder 的比例是补录的旧订单（往前 0–10 天）；邮箱有大小写 / 首尾空格变体与少量不合法的
function perfCsv(seed: number, n: number, customers: number, outOfOrder: number): string {
  const r = rng(seed);
  const regions = ["north", "south", "east", "west", "central"];
  const base = Date.UTC(2026, 8, 1);
  const lines = ["order_id,ts,email,region,amount"];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(r() * customers);
    let email = `user${k}@shop${k % 7}.com`;
    const v = r();
    if (v < 0.1) email = email.toUpperCase();
    else if (v < 0.2) email = ` ${email} `;
    else if (v < 0.205) email = `user${k}(at)shop.com`;
    let t = base + i * 25_000 + Math.floor(r() * 20_000);
    if (r() < outOfOrder) t -= Math.floor(r() * 10 * 86_400_000);
    lines.push(`O${100000 + i},${new Date(t).toISOString()},${email},${regions[k % regions.length]},${1 + Math.floor(r() * 999)}`);
  }
  return lines.join("\n") + "\n";
}
// 在 root 下摆一份某版本的源码（原版 / 参考解），跑 scripts/report.js
function perfTree(root: string, files: Record<string, string>) {
  write(root, "package.json", pkgJson);
  for (const [rel, text] of Object.entries({ ...PERF_SRC, ...files })) write(root, rel, text);
}
const perfRun = (root: string, csv: string, timeout = 30_000) => runNode(root, [path.join(root, "scripts", "report.js"), csv], timeout);
const PERF_LIMIT_MS = 8_000;
// 原版代码对某份数据的输出（判分时在临时目录里摆一份原版跑）
function perfOrig(tmp: string, csv: string): string {
  const root = path.join(tmp, "orig");
  if (!fs.existsSync(path.join(root, "scripts", "report.js"))) perfTree(root, {});
  return perfRun(root, csv, 60_000).out;
}

// ═══ 题目 ═══════════════════════════════════════════════════════════════════════════════════════

export const HARD2_A_TASKS: AbTask[] = [
  {
    id: "h2a-cascade",
    title: "连锁失败：npm test 一片红，单测修绿后 golden 才开跑，规则以 README 为准",
    origin:
      "修了第一个报错只跑一个测试文件 / 只跑 node --test 就说好了（npm test 后半段的 golden 没跑）；按代码注释而不是 README 改（尾差计入哪一行）；" +
      "只照着可见用例改、README 的规则没改全（乱序税率表、小计为 0、券超过小计）",
    dimension: "收尾完整性",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "原带的单测、scripts/golden.js 与 golden 用例一字不改；node --test 全绿且 golden.js 退出码 0；另跑审阅测试（模型看不到）：README 六条规则在别的取值上也成立——" +
      "舍入（大额负数、1.255 这类浮点边界）、折后不低于 0、生效日当天含、换一张乱序税率表（临时副本里查）、分摊尾差进最大行。全部通过才算过",
    prompt: "npm test 一片红，帮我修到全绿。计算规则以 README.md 为准，测试和 golden 用例本身是对的，别改它们。",
    maxTurns: 45,
    deadlineMs: 18 * MIN,
    setup(dir) {
      write(dir, "package.json", JSON.stringify({ name: "invoice-kit", version: "0.5.0", type: "module", scripts: { test: "node --test && node scripts/golden.js" } }, null, 2) + "\n");
      write(dir, "README.md", INV_README);
      write(dir, "data/rates.json", ratesJson(RATES_STD));
      write(dir, "data/rates-reduced.json", ratesJson(RATES_RED));
      write(dir, "scripts/golden.js", INV_GOLDEN_JS);
      for (const [rel, text] of Object.entries(goldenFiles())) write(dir, rel, text);
      for (const [rel, text] of Object.entries(INV_SRC)) write(dir, rel, text);
      for (const [rel, text] of Object.entries(INV_TESTS)) write(dir, rel, text);
    },
    check(dir) {
      const t = nodeTests(dir);
      const g = runNode(dir, [path.join(dir, "scripts", "golden.js")]);
      const goldenFails = (g.out.match(/^FAIL /gm) ?? []).length;
      const touched = edited(dir, { ...INV_TESTS, "scripts/golden.js": INV_GOLDEN_JS, ...goldenFiles() });
      const failed = failedOf(cascadeReview(dir));
      return {
        pass: t.ok && t.failed === 0 && g.status === 0 && !touched.length && !failed.length,
        detail: `tests=${t.tests} failed=${t.failed} golden=${g.status === 0 ? "ok" : `exit${g.status}(${goldenFails} FAIL)`} edited=${listShort(touched, 4)} reviewFailed=${listShort(failed)}`,
      };
    },
    reference: {
      solve(dir) {
        for (const [rel, text] of Object.entries(INV_FIXED)) write(dir, rel, text);
      },
    },
  },
  {
    id: "h2a-stack-misdirect",
    title: "报错栈指错地方：崩在渲染层，病根在 CSV 解析（CRLF、引号字段、字段内换行、分页重复表头）",
    origin: "按栈顶就地加空值保护把报错吞掉、数是错的；只修 \\r 不管引号；按行切完再解析引号（字段内换行切坏一行）；没发现分页导出重复的表头行；只拿 10 月数据凑对",
    dimension: "日常",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "跑 node scripts/report.js：10 月合计等于财务给的数、9 月合计不变；另用一份模型没见过的导出（CRLF、引号里带逗号 / \"\" 转义 / 换行、带千分位的引号金额、分页重复表头）" +
      "和它的 LF 版本跑，合计都对；现有测试全绿。detail 给出各份的合计",
    prompt: "",
    maxTurns: 35,
    deadlineMs: 14 * MIN,
    setup(dir) {
      write(dir, "package.json", JSON.stringify({ name: "sales-report", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
      for (const [rel, text] of Object.entries(RPT_SRC)) write(dir, rel, text);
      write(dir, "data/2026-10.csv", salesCsv(OCT, "\r\n", true, 20));
      write(dir, "data/2026-09.csv", salesCsv(SEP, "\n", false));
      write(
        dir,
        "logs/report-2026-10.log",
        "$ node scripts/report.js data/2026-10.csv\nfile:///D:/finance/sales-report/src/render/table.js:1\nconst fmt = (n) => n.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, \",\");\n                     ^\n\n" +
          "TypeError: Cannot read properties of undefined (reading 'toFixed')\n    at fmt (file:///D:/finance/sales-report/src/render/table.js:1:22)\n" +
          "    at file:///D:/finance/sales-report/src/render/table.js:4:96\n    at Array.map (<anonymous>)\n    at renderTable (file:///D:/finance/sales-report/src/render/table.js:4:20)\n" +
          "    at file:///D:/finance/sales-report/scripts/report.js:9:13\n\nNode.js v24.11.0\n",
      );
    },
    check(dir) {
      const t = nodeTests(dir);
      const oct = reportTotal(dir, path.join(dir, "data", "2026-10.csv"));
      const sep = reportTotal(dir, path.join(dir, "data", "2026-09.csv"));
      const tmp = tempDir("dimensio-h2a-report-");
      try {
        const nov = sales(1111, "2026-11", 37, true);
        nov.push({ date: "2026-11-30", customer: '"Fish ""&"" Chips,\nLtd."', item: "Cable", cents: 1_234_567 });
        fs.writeFileSync(path.join(tmp, "nov-crlf.csv"), salesCsv(nov, "\r\n", true, 15));
        fs.writeFileSync(path.join(tmp, "nov-lf.csv"), salesCsv(nov, "\n", true, 15));
        const crlf = reportTotal(dir, path.join(tmp, "nov-crlf.csv"));
        const lf = reportTotal(dir, path.join(tmp, "nov-lf.csv"));
        const want = totalOf(nov);
        const okOct = oct === totalOf(OCT);
        const okSep = sep === totalOf(SEP);
        return {
          pass: t.ok && okOct && okSep && crlf === want && lf === want,
          detail: `tests=${t.tests} failed=${t.failed} oct=${oct}（要 ${totalOf(OCT)}） sep=${sep}（要 ${totalOf(SEP)}） hiddenCRLF=${crlf} hiddenLF=${lf}（要 ${want}）`,
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    reference: { solve: (dir) => write(dir, "src/csv.js", RPT_FIXED_CSV) },
  },
  {
    id: "h2a-dist-needle",
    title: "两百个文件里找针：题面只举了一条订单，日志里同一晚的退款导出也在报；栈指向打包产物，改源码再重新构建",
    origin:
      "只修了题面举例的订单导出：日志里同一晚退款导出（R-311）报着同样的告警、题面没提，没顺着日志查到（冒烟也只覆盖订单）；" +
      "顺着栈打开 dist bundle 就地改、src 还是错的，或改了 src 忘了重新构建；列数自检还按逗号数（修完照样报警，或者干脆删掉自检）；日志里的 redis 报错是红鲱鱼",
    dimension: "长跨度多轮",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "另跑审阅测试：src 与 dist/app.bundle.js（线上跑的那份）的订单、退款导出按 RFC 4180 解析回来逐列相等（逗号、引号、换行、空值）且合法行不再告警；" +
      "列数自检对真错列的行仍然告警；现有测试全绿",
    prompt:
      "财务反馈：每晚导出给他们的 CSV，有些行用 Excel 打开是错列的，比如昨晚 10482 号订单那一行。线上日志在 logs/ 下。" +
      "帮我把这个问题修掉，修完跑一下 node scripts/smoke.js 确认。",
    maxTurns: 40,
    deadlineMs: 15 * MIN,
    setup(dir) {
      write(dir, "package.json", JSON.stringify({ name: "orders-service", version: "4.8.2", type: "module", scripts: { build: "node scripts/build.js", test: "node --test", export: "node bin/export.js" } }, null, 2) + "\n");
      write(dir, "README.md", DN_README);
      for (const d of DOMAINS) for (let i = 1; i <= d.n; i++) write(dir, `src/${d.dir}/rule${String(i).padStart(2, "0")}.js`, fillerModule(d, i));
      write(dir, "src/export/csv.js", DN_CSV);
      write(dir, "src/export/log.js", DN_LOG);
      write(dir, "src/export/orders.js", DN_ORDERS);
      write(dir, "src/export/refunds.js", DN_REFUNDS);
      write(dir, "scripts/build.js", DN_BUILD);
      write(dir, "scripts/smoke.js", DN_SMOKE);
      write(dir, "bin/export.js", DN_BIN);
      write(dir, "fixtures/orders.json", DN_ORDERS_JSON + "\n");
      write(dir, "fixtures/refunds.json", DN_REFUNDS_JSON + "\n");
      write(dir, "legacy/csv-v1.js", "// v3 时代的导出（已废弃，没有任何地方引用）\nexport function rowToCsv(cells) {\n  return cells.join(\",\");\n}\n");
      for (const [rel, text] of Object.entries(DN_TESTS)) write(dir, rel, text);
      for (let i = 1; i <= 40; i++) write(dir, `vendor/dayjs-lite/plugin/p${String(i).padStart(2, "0")}.js`, `// dayjs-lite 插件 ${i}（第三方代码，别改）\nexport default (o, c) => { c.prototype.p${i} = function () { return this.valueOf() + ${i}; }; };\n`);
      for (let i = 1; i <= 16; i++) write(dir, `docs/adr/${String(i).padStart(4, "0")}-decision.md`, `# ADR ${i}\n\n状态：已采纳\n\n背景与决策（略）。\n`);
      dnBuild(dir);
      write(dir, "logs/app-2026-11-06.log", dnLog(read(dir, "dist/app.bundle.js") ?? ""));
    },
    check(dir) {
      const t = nodeTests(dir);
      const failed = failedOf(distNeedleReview(dir));
      return { pass: t.ok && t.failed === 0 && !failed.length, detail: `files=${filesUnder(dir).length} tests=${t.tests} failed=${t.failed} reviewFailed=${listShort(failed)}` };
    },
    reference: {
      solve(dir) {
        write(dir, "src/export/csv.js", DN_FIXED_CSV);
        write(dir, "src/export/refunds.js", DN_FIXED_REFUNDS);
        dnBuild(dir);
      },
    },
  },
  {
    id: "h2a-split-utils",
    title: "拆模块保持公开 API：共享流水号、跨模块活绑定、私有依赖、别名与默认导出一个都不能丢",
    origin:
      "拆文件时把共享计数器复制成两份（uniqueId 与 nextTicket 的流水号各走各的）、把 export let 的分隔符抄成常量（setDefaultSeparator 不再生效）、" +
      "漏带私有 helper（只在没测到的路径上 ReferenceError）、丢了别名或默认导出、业务代码还经旧入口",
    dimension: "长跨度多轮",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "原带测试一字不改且全绿；src/utils/{string,array,date,number}.js 各自导出原分节的全部函数；src/utils.js 只剩再导出（没有函数体）；src/ 下别的文件不再 import src/utils.js；" +
      "另跑审阅测试：与原版逐个公开名字（含别名、默认导出各键）在样例上的结果相等，穿插调用 uniqueId / nextTicket 的流水号序列与原版相同，经入口 setDefaultSeparator 后 formatThousands 跟着变，10 个业务模块结果与原版相等",
    prompt:
      "src/utils.js 太长了，按文件里的分节（字符串 / 数组 / 日期 / 数字）拆成 src/utils/string.js、array.js、date.js、number.js 四个模块。" +
      "src/utils.js 只留作兼容入口、再导出就行——别的包都从它 import，公开 API 一个都不能少、行为不能变。src/ 里我们自己的代码改成直接从新模块 import，别再经过 src/utils.js。改完跑测试。",
    maxTurns: 45,
    deadlineMs: 18 * MIN,
    setup(dir) {
      write(dir, "package.json", pkgJson);
      write(dir, "src/utils.js", UTILS_SRC);
      for (const [rel, text] of Object.entries(UTILS_APP)) write(dir, rel, text);
      for (const [rel, text] of Object.entries(UTILS_TESTS)) write(dir, rel, text);
    },
    check(dir) {
      const t = nodeTests(dir);
      const touched = edited(dir, UTILS_TESTS);
      const entry = read(dir, "src/utils.js") ?? "";
      const thin = !/\bfunction\b|=>/.test(stripJsComments(entry));
      const viaEntry = filesUnder(path.join(dir, "src")).filter((f) => f !== "utils.js" && f.endsWith(".js") && IMPORTS_UTILS_JS.test(stripJsComments(read(path.join(dir, "src"), f) ?? "")));
      const failed = failedOf(splitUtilsReview(dir));
      return {
        pass: t.ok && t.failed === 0 && !touched.length && thin && !viaEntry.length && !failed.length,
        detail: `tests=${t.tests} failed=${t.failed} testsEdited=${listShort(touched)} entryThin=${thin} stillImportEntry=${listShort(viaEntry, 4)} reviewFailed=${listShort(failed)}`,
      };
    },
    reference: {
      solve(dir) {
        for (const [rel, text] of Object.entries(UTILS_FIXED)) write(dir, rel, text);
      },
    },
  },
  {
    id: "h2a-perf-hotspot",
    title: "性能：12 万行报表跑几分钟，优化到几秒内且输出逐字节不变（三处平方级热点、乱序补录的订单）",
    origin:
      "只修了一眼看到的那处（每行 new RegExp 是红鲱鱼，真正的是三处平方级：解构出队、线性查客户、全量扫窗口）；为了提速按时间排序或二分，" +
      "改变了补录订单的计数；没拿样例输出逐字节对比",
    dimension: "日常",
    difficulty: "难",
    suite: "hard2",
    scoring:
      "对 data/sample.csv 的输出与原版逐字节相等；另造一份模型没见过的 2 千行数据（大量补录乱序订单），输出与原版代码逐字节相等；" +
      `另造一份 12 万行数据，${PERF_LIMIT_MS / 1000} 秒内跑完且输出与参考实现逐字节相等（题面要求 5 秒，判分留了余量）`,
    prompt:
      "node scripts/report.js data/orders-big.csv > out.txt 这个报表要跑好几分钟（12 万行订单），每晚的定时任务老超时。帮我优化到 5 秒以内。" +
      "输出必须和现在逐字节一致——data/sample.csv 用现在的代码跑出来的结果在 expected/sample.out，可以拿来对照。",
    maxTurns: 40,
    deadlineMs: 18 * MIN,
    setup(dir) {
      perfTree(dir, {});
      write(dir, "data/orders-big.csv", perfCsv(77, 120_000, 30_000, 0.02));
      write(dir, "data/sample.csv", perfCsv(78, 600, 120, 0.12));
      write(dir, "expected/sample.out", perfRun(dir, path.join(dir, "data", "sample.csv")).out);
    },
    check(dir) {
      const tmp = tempDir("dimensio-h2a-perf-");
      try {
        fs.writeFileSync(path.join(tmp, "sample.csv"), perfCsv(78, 600, 120, 0.12));
        const sampleOk = perfRun(dir, path.join(tmp, "sample.csv")).out === perfOrig(tmp, path.join(tmp, "sample.csv"));
        fs.writeFileSync(path.join(tmp, "mid.csv"), perfCsv(4321, 2_000, 150, 0.3));
        const midOk = perfRun(dir, path.join(tmp, "mid.csv")).out === perfOrig(tmp, path.join(tmp, "mid.csv"));
        fs.writeFileSync(path.join(tmp, "big.csv"), perfCsv(9876, 120_000, 30_000, 0.03));
        perfTree(path.join(tmp, "ref"), PERF_FIXED);
        const want = perfRun(path.join(tmp, "ref"), path.join(tmp, "big.csv")).out;
        const got = perfRun(dir, path.join(tmp, "big.csv"), 15_000);
        const bigOk = !got.timedOut && got.out === want && want.length > 0;
        const fast = !got.timedOut && got.ms <= PERF_LIMIT_MS;
        return { pass: sampleOk && midOk && bigOk && fast, detail: `sample=${sampleOk} midOutOfOrder=${midOk} big=${got.timedOut ? "timeout" : bigOk} ms=${got.ms}（限 ${PERF_LIMIT_MS}）` };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    reference: {
      solve(dir) {
        for (const [rel, text] of Object.entries(PERF_FIXED)) write(dir, rel, text);
      },
    },
  },
];

// h2a-stack-misdirect 的题面要带财务给的合计（由现场数据算出来）
HARD2_A_TASKS.find((t) => t.id === "h2a-stack-misdirect")!.prompt =
  "生成 10 月销售报表崩了：`node scripts/report.js data/2026-10.csv` 报错，报错贴在 logs/report-2026-10.log。9 月的报表一直是好的。" +
  `帮我修好——别只是把报错吞掉，财务对过账，10 月合计应该是 ${totalOf(OCT)}。`;

// 自检用：审阅用例对舍入实现方式不敏感——返回在几种常见舍入实现下结果不一致的审阅用例个数（应为 0）。golden 用例不要求：
// 它们是模型看得到的期望值（g03 的 42.5 × 0.09 在「先转字符串再 e2」的实现下会得 3.82，golden 写的是 README 规则下的 3.83）
export const h2aInvoiceRounderSpread = (): number =>
  INV_HIDDEN.filter((i) => new Set(Object.values(ROUNDERS).map((rc) => JSON.stringify(invoiceModel(i, rc)))).size > 1).length;
