// Q9（K48 / N48）：守卫测试包。把「修一次、换个文件又犯一次」的事故写成窄规则，存量用燃尽基线管：
//   - 某文件的命中数比基线（guards-baseline.json）多 → 红：这是新增的违规，报错里写着改用什么；
//   - 比基线少 → 只提示「顺手把基线下调」——存量只减不增；
//   - 单行豁免写成 `// guard: <规则> ok — <理由>`（写在该行行尾或上一行），理由不许空：没写理由的豁免本身判红。
// 用例数棘轮：每个 *.test.ts 里 test( 的个数不许比基线少——大改或迁移测试时悄悄丢了用例会被当场抓住；有意删减就在
// 同一提交里下调基线（改基线本身是一处要被审的 diff）。
// 守卫只读源码、不 import 被扫的模块，revdeps 点不到它：改了 harness 就跑全量（写进 harness/AGENTS.md）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CATALOG, clampEffort, EFFORT_ORDER } from "./catalog.ts";
import { toolDefs } from "./tools/registry.ts";

const SERVER = import.meta.dirname;
const HARNESS = path.dirname(SERVER);
const BASELINE_FILE = path.join(SERVER, "guards-baseline.json");
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as {
  rules: Record<string, Record<string, number>>;
  tests: Record<string, number>;
};

interface Rule {
  id: string;
  why: string; // 报错时告诉人（和 agent）改用什么
  re: RegExp;
  scope: "src" | "tests"; // src = server 下的非测试文件；tests = *.test.ts
  allowFiles?: string[]; // 规则所禁之事的唯一合法实现处
}

const RULES: Rule[] = [
  {
    id: "containment-startswith",
    why: "路径包含关系别手写 startsWith(root + sep)——大小写、盘符、根目录都会坑（#21 那类）；用 path.relative 判定（sandbox.ts 的写法）",
    re: /\.startsWith\((?!\s*["'`]\.\.)[^)]*path\.sep/,
    scope: "src",
  },
  {
    id: "raw-child-kill",
    why: "别直接 child.kill()：Windows 上它只结束外壳，孙进程留下（bash-abort 那次）；用 proc-tree.ts 的 killChildTree / killProcessTree",
    re: /\.kill\(\s*(?:["'`]SIG[A-Z]+["'`])?\s*\)/,
    scope: "src",
    allowFiles: ["proc-tree.ts"],
  },
  {
    id: "pid-liveness",
    why: "别用 process.kill(pid, 0) 判活：PID 会被复用（#77 同源）；按创建时间核对，或用自己持有的进程句柄",
    re: /process\.kill\([^,)]+,\s*0\s*\)/,
    scope: "src",
  },
  {
    id: "tmp-literal",
    why: "命令里别写 /tmp/：Windows 上 python / java 按当前盘符解析它；用 os.tmpdir()",
    re: /["'`]\/tmp\//,
    scope: "src",
  },
  {
    id: "taskkill-tree",
    why: "别用 taskkill /T：它只按 ParentProcessId 找子进程，会顺着悬空的父 PID 杀到不相干的进程（#77，生产上的 bridge 进程被这样带走过）；用 proc-tree.ts",
    re: /taskkill[^\n]*\s\/T\b|["'`]\/T["'`]/,
    scope: "src",
  },
  {
    id: "no-bare-fake-adapter",
    why: "测试里别再手写 async *stream() 假 provider：用 test-harness/scripted-adapter.ts（多调 / 少调判失败、请求不变量自动检查）；要看编码后的请求体用 test-harness/wire-fakes.ts",
    re: /async\s*\*\s*stream\s*\(/,
    scope: "tests",
  },
];

const EXEMPT_RE = /\/\/ guard: ([a-z-]+) ok\b(.*)$/;

function sourceFiles(): { rel: string; lines: string[] }[] {
  const out: { rel: string; lines: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(abs);
      } else if (/\.(ts|mjs)$/.test(entry.name)) {
        out.push({ rel: path.relative(SERVER, abs).replace(/\\/g, "/"), lines: fs.readFileSync(abs, "utf8").split(/\r?\n/) });
      }
    }
  };
  walk(SERVER);
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const isTestFile = (rel: string) => rel.endsWith(".test.ts");
const SELF = "guards.test.ts"; // 规则说明里就写着被禁的写法，不扫自己
const inScope = (rule: Rule, rel: string) =>
  rel !== SELF &&
  (rule.scope === "tests" ? isTestFile(rel) : !isTestFile(rel) && !rel.startsWith("test-harness/") && !rule.allowFiles?.includes(rel));

interface Hit {
  rel: string;
  line: number;
  text: string;
}

function scan(rule: Rule, files: { rel: string; lines: string[] }[]): { hits: Hit[]; badExemptions: Hit[] } {
  const hits: Hit[] = [];
  const badExemptions: Hit[] = [];
  for (const f of files) {
    if (!inScope(rule, f.rel)) continue;
    f.lines.forEach((line, i) => {
      if (isComment(line) || !rule.re.test(line)) return;
      const exempt = [line, f.lines[i - 1] ?? ""].map((l) => EXEMPT_RE.exec(l)).find((m) => m?.[1] === rule.id);
      if (exempt) {
        // 豁免必须写理由：`— <理由>`，理由至少两个字
        if (!/^\s*[—-]+\s*\S.{1,}/.test(exempt[2])) badExemptions.push({ rel: f.rel, line: i + 1, text: line.trim() });
        return;
      }
      hits.push({ rel: f.rel, line: i + 1, text: line.trim().slice(0, 120) });
    });
  }
  return { hits, badExemptions };
}

function countBy(hits: Hit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) out[h.rel] = (out[h.rel] ?? 0) + 1;
  return out;
}

const files = sourceFiles();

for (const rule of RULES) {
  test(`Q9 守卫 ${rule.id}：不许新增（存量只减不增）`, (t: TestContext) => {
    const { hits, badExemptions } = scan(rule, files);
    assert.deepEqual(badExemptions, [], `这些豁免没写理由（格式：// guard: ${rule.id} ok — <理由>）`);
    const now = countBy(hits);
    const base = baseline.rules[rule.id] ?? {};
    const grown = Object.keys(now).filter((rel) => now[rel] > (base[rel] ?? 0));
    const detail = grown
      .map((rel) => `  ${rel}：${now[rel]} 处（基线 ${base[rel] ?? 0}）\n${hits.filter((h) => h.rel === rel).map((h) => `    :${h.line}  ${h.text}`).join("\n")}`)
      .join("\n");
    assert.deepEqual(grown, [], `「${rule.id}」有新增违规——${rule.why}\n${detail}`);
    for (const rel of Object.keys(base)) {
      if ((now[rel] ?? 0) < base[rel]) t.diagnostic(`「${rule.id}」${rel} 从 ${base[rel]} 降到 ${now[rel] ?? 0}：请顺手把 guards-baseline.json 里的基线下调`);
    }
  });
}

test("Q9 用例数棘轮：每个测试文件的 test( 个数不许比基线少（有意删减就在同一提交里下调基线）", (t: TestContext) => {
  const counts: Record<string, number> = {};
  for (const f of files) if (isTestFile(f.rel)) counts[f.rel] = f.lines.filter((l) => /^\s*test\(/.test(l)).length;
  const dropped = Object.keys(baseline.tests).filter((rel) => (counts[rel] ?? 0) < baseline.tests[rel]);
  assert.deepEqual(
    dropped.map((rel) => `${rel}：${counts[rel] ?? 0}（基线 ${baseline.tests[rel]}）`),
    [],
    "这些测试文件的用例比基线少了——迁移或重写时丢了用例？有意删减就下调 guards-baseline.json 并在提交信息里写明原因",
  );
  const grown = Object.keys(counts).filter((rel) => counts[rel] > (baseline.tests[rel] ?? 0));
  if (grown.length) t.diagnostic(`这些测试文件的用例比基线多，请顺手把基线调上去（棘轮才卡得住）：${grown.map((rel) => `${rel} ${baseline.tests[rel] ?? 0}→${counts[rel]}`).join("，")}`);
});

// ── K48：今天成立的不变量，现在就守 ──────────────────────────────────────────
test("Q9 核心层厂商中立：server/agent/ 不 import 任何一家的适配器实现", () => {
  const offenders = files
    .filter((f) => f.rel.startsWith("agent/") && !isTestFile(f.rel))
    .flatMap((f) =>
      f.lines
        .filter((l) => /(?:\bfrom\s*|\bimport\s*\(?\s*)["'][^"']*providers\/(anthropic|openai|gemini)\.ts["']/.test(l))
        .map((l) => `${f.rel}: ${l.trim()}`),
    );
  assert.deepEqual(offenders, [], "loop / state 只认中立的 Turn 与 ProviderAdapter 接口；各家差异留在 providers/ 里");
});

test("Q9 前后端事件集合一致：后端发的每种事件前端都处理，前端 reducer 里没有后端不再发的事件", () => {
  const events = fs.readFileSync(path.join(SERVER, "agent", "events.ts"), "utf8");
  const tail = events.slice(events.indexOf("export type AgentEvent"));
  const end = tail.search(/\n(export |\/\/ ──)/);
  const body = end > 0 ? tail.slice(0, end) : tail;
  const backend = new Set([...body.matchAll(/(?<![A-Za-z0-9_])e:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
  const emit = /(?:fanout\(session,|send\(|cb\(|w\()\s*\{\s*e:\s*"([a-z0-9_]+)"/g;
  for (const file of ["session.ts", "index.ts"]) for (const m of fs.readFileSync(path.join(SERVER, file), "utf8").matchAll(emit)) backend.add(m[1]);

  const web = path.join(HARNESS, "web", "src");
  const handled = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|svelte|js)$/.test(entry.name)) for (const m of fs.readFileSync(abs, "utf8").matchAll(/\.e\s*[!=]==\s*"([a-z0-9_]+)"/g)) handled.add(m[1]);
    }
  };
  walk(web);
  const reducer = fs.readFileSync(path.join(web, "lib", "timeline-reducer.ts"), "utf8"); // Q11 起归约器在这里
  const cases = new Set([...reducer.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]));
  for (const c of cases) handled.add(c);

  assert.deepEqual([...backend].filter((e) => !handled.has(e)).sort(), [], "后端发了、前端没人处理的事件（要么前端补上，要么别发）");
  assert.deepEqual([...cases].filter((e) => !backend.has(e)).sort(), [], "前端 reducer 里处理着后端已经不发的事件（死分支）");
});

test("Q9 名字唯一：工具名不重复；每家的型号 id 不重复", () => {
  const names = toolDefs().map((d) => d.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], "工具名重复");
  for (const spec of CATALOG) {
    const ids = spec.models.map((m) => m.id);
    assert.deepEqual(ids.filter((n, i) => ids.indexOf(n) !== i), [], `${spec.id} 的型号 id 重复`);
  }
});

test("Q9 目录契约：默认型号在清单里；每个型号的档位合法、clampEffort 的结果总落在该型号的档位里", () => {
  for (const spec of CATALOG) {
    assert.ok(spec.models.some((m) => m.id === spec.defaultModel), `${spec.id} 的 defaultModel ${spec.defaultModel} 不在型号清单里`);
    for (const m of spec.models) {
      assert.ok(m.efforts.length > 0 && m.efforts.every((e) => EFFORT_ORDER.includes(e)), `${spec.id}/${m.id} 的档位不合法：${m.efforts.join(",")}`);
      for (const level of EFFORT_ORDER) {
        const got = clampEffort(spec.id, m.id, level);
        assert.ok(m.efforts.includes(got), `${spec.id}/${m.id}：clampEffort(${level}) = ${got}，不在 ${m.efforts.join(",")} 里`);
      }
    }
  }
});
