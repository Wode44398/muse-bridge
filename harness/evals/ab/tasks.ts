// Q6（N46）：A/B 评测台的陷阱任务。都取自 dimensio 自己的事故档案——弱模型最容易在这些地方翻车，某次改动让模型
// 「变笨」了，也最先在这里显形。每个任务：setup 在一个空目录里摆好现场；check 只看磁盘状态与会话记录（确定性判分）；
// origin 写明出处。先做 6 个，按需要往上加。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PersistedSession } from "../../server/store.ts";

export interface Verdict {
  pass: boolean;
  detail: string;
}

export interface CheckEnv {
  memoryDir: string;
}

export interface AbTask {
  id: string;
  title: string;
  origin: string; // 出自哪次事故
  prompt: string;
  maxTurns: number;
  deadlineMs: number;
  setup(dir: string): void;
  // env.memoryDir：这一臂的记忆根（瘦身 P0-1 的「偏好记住了没有」要看它）
  check(dir: string, rec: PersistedSession, env?: CheckEnv): Verdict;
  // 参考解，自检用（server/ab-eval.test.ts）：原样现场必须判不通过、做完参考解必须判通过——证明陷阱没有预先解开、
  // 判分也不是永远过不了。answer = 参考解的最终答复（只有看答复的任务需要）；calls = 参考解做过的（成功的）工具调用
  //（只有看会话记录的任务需要，例如 C5 的技能命中）；memory = 参考解该留下的记忆（写进 memoryDir）。
  reference: {
    solve?(dir: string): void;
    answer?: string;
    calls?: { name: string; args: Record<string, unknown> }[];
    memory?(memoryDir: string): void;
  };
  // C5：要配技能夹具（run.ts --ext-file，见 skills-fixture.ts）才有意义的任务
  needsSkills?: boolean;
}

const write = (dir: string, rel: string, text: string, encoding: BufferEncoding = "utf8") => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, encoding);
};
const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
};

// 在工作区里跑全部 node:test，作为「真的好了没有」的独立判据（不信模型自己说的）。
export function nodeTests(dir: string): { ok: boolean; tests: number; failed: number } {
  // 本进程若自己就跑在 node --test 里（自检），子进程会继承 NODE_TEST_CONTEXT、改用二进制协议汇报而不打印摘要行——去掉它。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000, env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fail = /^ℹ fail (\d+)/m.exec(out);
  const tests = /^ℹ tests (\d+)/m.exec(out);
  return { ok: r.status === 0 && Number(tests?.[1] ?? 0) > 0, tests: Number(tests?.[1] ?? 0), failed: Number(fail?.[1] ?? 0) };
}

// 最终答复（最后一条有正文的 assistant 消息）
export function finalAnswer(rec: PersistedSession): string {
  for (let i = rec.messages.length - 1; i >= 0; i--) {
    const m = rec.messages[i];
    if (m.role !== "assistant") continue;
    const text = m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("");
    if (text.trim()) return text;
  }
  return "";
}

const pkg = JSON.stringify({ name: "ab-task", type: "module", scripts: { test: "node --test" } }, null, 2);

export const TASKS: AbTask[] = [
  {
    id: "edit-multi-match",
    title: "多处匹配的 Edit：同一行出现两次，只改其中一处",
    origin: "Edit 的 old_string 不唯一时整条失败——模型要带上下文重试，而不是改错地方或整份重写",
    prompt: "src/config.js 里 client 的 timeout 改成 60，server 的 timeout 保持 30 不动。",
    maxTurns: 12,
    deadlineMs: 5 * 60_000,
    setup(dir: string) {
      write(dir, "package.json", pkg);
      write(dir, "src/config.js", "export const config = {\n  server: {\n    host: \"0.0.0.0\",\n    timeout: 30,\n  },\n  client: {\n    retries: 3,\n    timeout: 30,\n  },\n};\n");
    },
    check(dir: string) {
      const text = read(dir, "src/config.js") ?? "";
      const server = /server:\s*\{[^}]*timeout:\s*(\d+)/.exec(text)?.[1];
      const client = /client:\s*\{[^}]*timeout:\s*(\d+)/.exec(text)?.[1];
      return { pass: server === "30" && client === "60" && text.includes('host: "0.0.0.0"') && text.includes("retries: 3"), detail: `server=${server} client=${client}` };
    },
    reference: {
      solve(dir: string) {
        write(dir, "src/config.js", (read(dir, "src/config.js") ?? "").replace("retries: 3,\n    timeout: 30", "retries: 3,\n    timeout: 60"));
      },
    },
  },
  {
    id: "neighbor-tests",
    title: "漏跑邻居测试：改了被别处引用的函数，只跑本模块的测试会漏掉",
    origin: "#20 / revdeps：改动的反向依赖里有测试，模型只跑了自己那个就说好了",
    prompt: "把 src/math.js 里的 sum 改名为 total（调用它的地方一起改），改完跑测试确认。",
    maxTurns: 20,
    deadlineMs: 8 * 60_000,
    setup(dir: string) {
      write(dir, "package.json", pkg);
      write(dir, "src/math.js", "export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n");
      write(dir, "src/report/stats.js", "import { sum } from \"../math.js\";\n\nexport function mean(xs) {\n  return xs.length ? sum(xs) / xs.length : 0;\n}\n");
      write(dir, "test/math.test.js", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport * as m from \"../src/math.js\";\n\ntest(\"sum of numbers\", () => {\n  const f = m.total ?? m.sum;\n  assert.equal(f([1, 2, 3]), 6);\n});\n");
      write(dir, "test/report/stats.test.js", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { mean } from \"../../src/report/stats.js\";\n\ntest(\"mean\", () => {\n  assert.equal(mean([2, 4]), 3);\n});\n");
    },
    check(dir: string) {
      const math = read(dir, "src/math.js") ?? "";
      const t = nodeTests(dir);
      return { pass: /function total\s*\(/.test(math) && !/function sum\s*\(/.test(math) && t.ok, detail: `renamed=${/function total/.test(math)} tests=${t.tests} failed=${t.failed}` };
    },
    reference: {
      solve(dir: string) {
        for (const rel of ["src/math.js", "src/report/stats.js"]) write(dir, rel, (read(dir, rel) ?? "").replace(/\bsum\b/g, "total"));
      },
    },
  },
  {
    id: "patch-already-applied",
    title: "补丁已经在了：要做的改动其实已经存在",
    origin: "K13：模型不看现状就动手，把已经对的东西又改一遍（改坏或重复）",
    prompt: "给 src/greet.js 的 greet 函数加上默认参数 name = \"world\"，然后跑测试。",
    maxTurns: 12,
    deadlineMs: 5 * 60_000,
    setup(dir: string) {
      write(dir, "package.json", pkg);
      write(dir, "src/greet.js", "export function greet(name = \"world\") {\n  return `hello, ${name}`;\n}\n");
      write(dir, "test/greet.test.js", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { greet } from \"../src/greet.js\";\n\ntest(\"default name\", () => {\n  assert.equal(greet(), \"hello, world\");\n});\n");
    },
    check(dir: string, rec: PersistedSession) {
      const src = read(dir, "src/greet.js") ?? "";
      const t = nodeTests(dir);
      const noticed = /已经|已有|already|exists|no change|无需/i.test(finalAnswer(rec));
      const intact = (src.match(/name = "world"/g) ?? []).length === 1;
      return { pass: t.ok && intact && noticed, detail: `tests=${t.ok} intact=${intact} saidAlreadyDone=${noticed}` };
    },
    reference: { answer: 'greet 已经有默认参数 name = "world"，无需改动；测试通过。' },
  },
  {
    id: "tail-evidence",
    title: "失败藏在长输出中间：只看输出末尾会把失败当成通过",
    origin: "#19：用 | tail 截尾交证据，管道吞掉了失败",
    prompt: "src/parse.js 的 parseRow 有 bug，修好它。测试输出很长，确认全部测试都通过再收工。",
    maxTurns: 20,
    deadlineMs: 8 * 60_000,
    setup(dir: string) {
      write(dir, "package.json", pkg);
      write(dir, "src/parse.js", "export function parseRow(line) {\n  const [name, qty] = line.split(\",\");\n  return { name: name.trim(), qty: Number(qty) + 1 };\n}\n");
      const many = Array.from({ length: 60 }, (_, i) => `test("noise ${i}", () => { assert.ok(true); });`).join("\n");
      write(dir, "test/a-noise.test.js", `import test from "node:test";\nimport assert from "node:assert/strict";\n${many}\n`);
      write(dir, "test/parse.test.js", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { parseRow } from \"../src/parse.js\";\n\ntest(\"parses quantity\", () => {\n  assert.deepEqual(parseRow(\"apple, 3\"), { name: \"apple\", qty: 3 });\n});\n");
      write(dir, "test/z-noise.test.js", `import test from "node:test";\nimport assert from "node:assert/strict";\n${many}\n`);
    },
    check(dir: string) {
      const t = nodeTests(dir);
      return { pass: t.ok, detail: `tests=${t.tests} failed=${t.failed}` };
    },
    reference: {
      solve(dir: string) {
        write(dir, "src/parse.js", (read(dir, "src/parse.js") ?? "").replace("Number(qty) + 1", "Number(qty)"));
      },
    },
  },
  {
    id: "large-output",
    title: "大输出：答案埋在几千行日志里，整份读会被截断",
    origin: "工具输出有上限：该用 Grep / 定位读，而不是整份 Read 然后猜",
    prompt: "logs/app.log 里有一行 ERROR，把那一行里的 request id（形如 req-xxxxxx）写进 answer.txt，只写 id 本身。",
    maxTurns: 12,
    deadlineMs: 5 * 60_000,
    setup(dir: string) {
      const lines: string[] = [];
      for (let i = 0; i < 6000; i++) lines.push(`2026-09-24T10:${String(i % 60).padStart(2, "0")}:00Z INFO request req-${(100000 + i).toString(36)} ok in ${i % 97}ms`);
      lines.splice(4321, 0, "2026-09-24T11:11:11Z ERROR request req-q6trap failed: upstream reset");
      write(dir, "logs/app.log", lines.join("\n") + "\n");
    },
    check(dir: string) {
      const answer = (read(dir, "answer.txt") ?? "").trim();
      return { pass: answer === "req-q6trap", detail: `answer=${JSON.stringify(answer.slice(0, 40))}` };
    },
    reference: {
      solve(dir: string) {
        write(dir, "answer.txt", "req-q6trap\n");
      },
    },
  },
  {
    id: "gbk-file",
    title: "GBK 编码的旧文件：按 UTF-8 读出来是乱码",
    origin: "19250ba：GBK 乱码——要认出编码再转，而不是把乱码照抄出去",
    prompt: "legacy/company.txt 是 GBK 编码的旧文件，第一行是公司名。把公司名以 UTF-8 写进 name.txt，只写名字本身。",
    maxTurns: 12,
    deadlineMs: 5 * 60_000,
    setup(dir: string) {
      // 「维度科技有限公司」的 GBK 字节
      const gbk = Buffer.from("ceacb6c8bfc6bcbcd3d0cfdeb9abcbbe", "hex");
      fs.mkdirSync(path.join(dir, "legacy"), { recursive: true });
      fs.writeFileSync(path.join(dir, "legacy", "company.txt"), Buffer.concat([gbk, Buffer.from("\r\n")]));
    },
    check(dir: string) {
      const name = (read(dir, "name.txt") ?? "").trim();
      return { pass: name === "维度科技有限公司", detail: `name=${JSON.stringify(name)}` };
    },
    reference: {
      solve(dir: string) {
        const first = new TextDecoder("gbk").decode(fs.readFileSync(path.join(dir, "legacy", "company.txt"))).split(/\r?\n/)[0];
        write(dir, "name.txt", `${first}\n`);
      },
    },
  },
  ...SLIM_TASKS(),
];

// ── 瘦身 P0（2026-10-07）：日常场景的流程税与按需注入 ─────────────────────────────
// 前 6 个陷阱都是编码题，量不出「每条消息多一次审计」「专章搬走之后还管不管用」。这 6 个照正式服的日常形态补上：纯问答、
// 看一眼工作区就答、文档整理（不该有验证门）、用户表达偏好（记忆还记不记得下来——P0-1 把审计挪到了 run 之后）、
// 做个网页并用浏览器验证（网页专章改成按需注入——P0-3）、多步实现（待办提醒不落盘——P0-2）。
function filesUnder(dir: string, skip = /^\.dimensio$/): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (skip.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk("");
  return out.sort();
}

// 这一臂的记忆根里有没有一条同时说到这些的笔记（工作区层或全局层都算；历史版本不算）
function memoryMentions(memoryDir: string | undefined, all: RegExp[]): boolean {
  if (!memoryDir) return false;
  return filesUnder(memoryDir, /^\.history$/)
    .filter((f) => f.endsWith(".md"))
    .some((f) => {
      const text = fs.readFileSync(path.join(memoryDir, f), "utf8");
      return all.every((re) => re.test(text));
    });
}

// 会话记录里有没有一次成功的验证（带 verify:true 的调用、结果 ok）
function verifiedOnce(rec: PersistedSession): boolean {
  const okIds = new Set<string>();
  for (const m of rec.messages) for (const b of m.content) if (b.t === "tool_result" && b.ok) okIds.add(b.id);
  return rec.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call" && okIds.has(b.id) && (b.args as { verify?: unknown })?.verify === true));
}

// 用 Bash 把服务丢到后台（`node server.js &`）——网页专章第一条就禁止的做法
function backgroundedServer(rec: PersistedSession): boolean {
  return rec.messages.some((m) =>
    m.role === "assistant" &&
    m.content.some((b) => b.t === "tool_call" && b.name === "Bash" && /\b(?:node|npm|npx|python3?|http-server|serve|vite)\b[^\n|;]*&\s*$/m.test(String((b.args as { command?: unknown })?.command ?? ""))),
  );
}

function SLIM_TASKS(): AbTask[] {
  const QA_FILES = ["README.md"];
  return [
    {
      id: "qa-plain",
      title: "纯问答：不碰工作区，一轮答完",
      origin: "瘦身 P0-1：正式服日常提问 34% 的调用是纯流程轮（答完被拉回来交 MemoryAudit）",
      prompt: "TCP 为什么是三次握手而不是两次？三句话以内，直接回答。",
      maxTurns: 6,
      deadlineMs: 3 * 60_000,
      setup(dir: string) {
        write(dir, "README.md", "# scratch\n");
      },
      check(dir: string, rec: PersistedSession) {
        const answer = finalAnswer(rec);
        const untouched = JSON.stringify(filesUnder(dir)) === JSON.stringify(QA_FILES);
        const onTopic = /SYN|ACK|序列号|确认|握手/.test(answer);
        return { pass: answer.trim().length >= 20 && onTopic && untouched, detail: `answered=${answer.trim().length} onTopic=${onTopic} untouched=${untouched}` };
      },
      reference: { answer: "两次握手时服务端无法确认客户端收到了自己的 SYN 与初始序列号，过期的重复连接请求也会被当成新连接；第三次 ACK 让双方都确认了对方的收发能力。" },
    },
    {
      id: "qa-workspace",
      title: "看一眼工作区就答：只读、不改文件",
      origin: "瘦身 P0-1：正式服「看一下这个库是干嘛的」类问题，答完还要多交一轮审计",
      prompt: "这个项目用的是什么测试框架？看一眼回答就行，不要改任何文件。",
      maxTurns: 8,
      deadlineMs: 3 * 60_000,
      setup(dir: string) {
        write(dir, "package.json", JSON.stringify({ name: "ab-ws", type: "module", scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.1.0" } }, null, 2));
        write(dir, "vitest.config.ts", "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"test/**/*.test.ts\"] } });\n");
        write(dir, "src/a.ts", "export const a = 1;\n");
        write(dir, "test/a.test.ts", "import { expect, test } from \"vitest\";\nimport { a } from \"../src/a\";\ntest(\"a\", () => expect(a).toBe(1));\n");
      },
      check(dir: string, rec: PersistedSession) {
        const answer = finalAnswer(rec);
        const files = filesUnder(dir);
        const untouched = JSON.stringify(files) === JSON.stringify(["package.json", "src/a.ts", "test/a.test.ts", "vitest.config.ts"]);
        return { pass: /vitest/i.test(answer) && untouched, detail: `saidVitest=${/vitest/i.test(answer)} files=${files.join(",")}` };
      },
      reference: { answer: "用的是 Vitest（package.json 的 test 脚本是 vitest run）。" },
    },
    {
      id: "doc-tidy",
      title: "文档整理：原文整理成 Markdown，不增删内容",
      origin: "瘦身 P0：正式服文档类会话（翻译、整理资料）占约两成，流程轮占 11%",
      prompt: "把 notes/raw.txt 整理成 notes/clean.md：第一行是一级标题，其余每条变成一个列表项，内容不要增删改写。",
      maxTurns: 10,
      deadlineMs: 4 * 60_000,
      setup(dir: string) {
        write(dir, "notes/raw.txt", "周会记录 10月7日\n张三：登录页改版下周一上线\n李四：支付回调偶发超时，周三前排查完\n王五：新同学入职，周五做环境配置\n结论：下次周会改到周二上午\n");
      },
      check(dir: string) {
        const md = read(dir, "notes/clean.md") ?? "";
        const first = md.split(/\r?\n/).find((l) => l.trim()) ?? "";
        const items = (md.match(/^\s*[-*] /gm) ?? []).length;
        const kept = ["登录页改版下周一上线", "支付回调偶发超时，周三前排查完", "周五做环境配置", "下次周会改到周二上午"].filter((s) => md.includes(s)).length;
        return { pass: /^# .*周会/.test(first) && items >= 4 && kept === 4, detail: `title=${JSON.stringify(first.slice(0, 30))} items=${items} kept=${kept}/4` };
      },
      reference: {
        solve(dir: string) {
          write(dir, "notes/clean.md", "# 周会记录 10月7日\n\n- 张三：登录页改版下周一上线\n- 李四：支付回调偶发超时，周三前排查完\n- 王五：新同学入职，周五做环境配置\n- 结论：下次周会改到周二上午\n");
        },
      },
    },
    {
      id: "pref-memory",
      title: "用户表达长期偏好：要记得下来（下个会话能用）",
      origin: "瘦身 P0-1：审计挪到 run 之后——偏好不能因此丢",
      prompt: "以后这个项目的 git 提交信息一律用中文写，记住这一点。顺便告诉我 package.json 里的 name 是什么。",
      maxTurns: 8,
      deadlineMs: 4 * 60_000,
      setup(dir: string) {
        write(dir, "package.json", JSON.stringify({ name: "lumen-notes", version: "0.3.1", private: true }, null, 2));
      },
      check(dir: string, rec: PersistedSession, env?: CheckEnv) {
        const named = finalAnswer(rec).includes("lumen-notes");
        const remembered = memoryMentions(env?.memoryDir, [/中文/, /提交|commit/i]);
        return { pass: named && remembered, detail: `named=${named} remembered=${remembered}` };
      },
      reference: {
        answer: "name 是 lumen-notes。提交信息用中文这条已经记下了。",
        memory(memoryDir: string) {
          write(memoryDir, "workspaces/ab/commit-language.md", "---\ntitle: 提交信息用中文\n---\n\n这个项目的 git 提交信息用中文写。\n");
        },
      },
    },
    {
      id: "web-counter",
      title: "做个网页并用浏览器验证：专章按需注入后还管不管用",
      origin: "瘦身 P0-3：网页验证一章从 system 搬成写下网页文件后才注入的 playbook",
      prompt: "做一个 counter.html：页面上显示一个数字（初始 0）和一个「+1」按钮，点一下数字加一。交付前用浏览器真的点一下，确认数字变了。",
      maxTurns: 30,
      deadlineMs: 10 * 60_000,
      setup() {},
      check(dir: string, rec: PersistedSession) {
        const html = read(dir, "counter.html") ?? "";
        const page = /<button/i.test(html) && /\+1/.test(html) && /onclick|addEventListener/i.test(html);
        const verified = verifiedOnce(rec);
        const bg = backgroundedServer(rec);
        return { pass: page && verified && !bg, detail: `page=${page} verified=${verified} bashBackgroundedServer=${bg}` };
      },
      reference: {
        solve(dir: string) {
          write(dir, "counter.html", "<!doctype html><meta charset=\"utf-8\"><p id=\"n\">0</p><button id=\"b\">+1</button>\n<script>let n = 0; document.getElementById(\"b\").addEventListener(\"click\", () => { document.getElementById(\"n\").textContent = String(++n); });</script>\n");
        },
        calls: [{ name: "Eval", args: { js: "document.getElementById('n').textContent === '1'", verify: true } }],
      },
    },
    {
      id: "multi-step",
      title: "多步实现：四个函数 + 测试，跑通再交",
      origin: "瘦身 P0-2：待办提醒改成只挂在请求末尾、不进转录——多步任务的节奏不能乱",
      prompt: "在 src/calc.js 里实现并导出 add、sub、mul、div 四个函数（div 除数为 0 时抛错），在 test/calc.test.js 里给每个函数各写至少一个 node:test 测试，最后跑测试确认全部通过。",
      maxTurns: 30,
      deadlineMs: 10 * 60_000,
      setup(dir: string) {
        write(dir, "package.json", pkg);
      },
      check(dir: string) {
        const t = nodeTests(dir);
        const calc = path.join(dir, "src", "calc.js");
        const probe = fs.existsSync(calc)
          ? spawnSync(process.execPath, ["--input-type=module", "-e",
            `const m = await import(${JSON.stringify(pathToFileURL(calc).href)});
             let threw = false; try { m.div(1, 0); } catch { threw = true; }
             console.log(m.add(2, 3) === 5 && m.sub(5, 3) === 2 && m.mul(2, 3) === 6 && m.div(6, 3) === 2 && threw ? "OK" : "BAD");`], { encoding: "utf8", timeout: 20_000 })
          : null;
        const behaves = probe?.stdout.trim() === "OK";
        return { pass: t.ok && t.tests >= 4 && behaves, detail: `tests=${t.tests} failed=${t.failed} behaves=${behaves}` };
      },
      reference: {
        solve(dir: string) {
          write(dir, "src/calc.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\nexport function div(a, b) {\n  if (b === 0) throw new Error(\"division by zero\");\n  return a / b;\n}\n");
          write(dir, "test/calc.test.js", "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { add, sub, mul, div } from \"../src/calc.js\";\n\ntest(\"add\", () => assert.equal(add(2, 3), 5));\ntest(\"sub\", () => assert.equal(sub(5, 3), 2));\ntest(\"mul\", () => assert.equal(mul(2, 3), 6));\ntest(\"div\", () => { assert.equal(div(6, 3), 2); assert.throws(() => div(1, 0)); });\n");
        },
      },
    },
  ];
}

// ── C5：技能命中率 ─────────────────────────────────────────────────────────────
// 要配 --ext-file 指向技能夹具（evals/ab/skills-fixture.ts 照真注册表搭：形状一样、脚本是桩）。判分只看会话记录：有没有
// 成功加载对的技能——Skill 工具按名加载，或者 Read / Bash 读了那个技能的 SKILL.md（C5 之前的目录只给路径，模型用 Read 读）。
export function loadedSkills(rec: PersistedSession): string[] {
  const okIds = new Set<string>();
  for (const m of rec.messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) if (b.t === "tool_result" && b.ok) okIds.add(b.id);
  }
  const out = new Set<string>();
  for (const m of rec.messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.t !== "tool_call" || !okIds.has(b.id)) continue;
      const a = (b.args ?? {}) as Record<string, unknown>;
      if (b.name === "Skill" && typeof a.name === "string") out.add(a.name.trim().toLowerCase());
      const text = b.name === "Read" ? String(a.path ?? "") : b.name === "Bash" ? String(a.command ?? "") : "";
      for (const hit of text.matchAll(/skills[\\/]+([^\\/"'\s]+)[\\/]+SKILL\.md/gi)) out.add(hit[1].toLowerCase());
    }
  }
  return [...out];
}

function skillTask(id: string, title: string, prompt: string, want: string[], setup: (dir: string) => void = () => {}): AbTask {
  return {
    id,
    title,
    origin: "C5（#10）：技能目录折叠之后，模型还找不找得到对的技能",
    prompt,
    maxTurns: 14,
    deadlineMs: 6 * 60_000,
    needsSkills: true,
    setup,
    check(_dir: string, rec: PersistedSession) {
      const loaded = loadedSkills(rec);
      return { pass: want.some((w) => loaded.includes(w)), detail: `loaded=${loaded.join(",") || "-"} want=${want.join("|")}` };
    },
    reference: { calls: [{ name: "Skill", args: { name: want[0] } }] },
  };
}

export const SKILL_TASKS: AbTask[] = [
  skillTask("skill-stock", "包里的技能、没点名：个股分析", "帮我分析一下贵州茅台（600519）现在值不值得投资，结论写进 answer.md。", ["stock-analysis", "stock-price-diagnosis"]),
  skillTask("skill-fund", "包里的技能、没点名：基金筛选", "筛选几只近一年收益靠前、回撤比较小的偏股型基金，列 5 只写进 answer.md，附上筛选条件。", ["fund-screening-workflow"]),
  skillTask("skill-caixin", "另一个包、点了数据源：财新宏观", "用财新的数据查一下全国 2023 年的常住人口和地区生产总值（GDP），写进 answer.md。", ["caixin-macro"]),
  skillTask("skill-named", "点名包里的某个技能", "用 dcf-valuation-model 这个技能给宁德时代（300750）搭一个 DCF 估值框架，写进 dcf.md。", ["dcf-valuation-model"]),
  skillTask("skill-excel", "单独的技能：Excel 报表", "把 data/sales.csv 做成一个带汇总公式的 Excel 报表 report.xlsx。", ["kimi-excel"], (dir) =>
    write(dir, "data/sales.csv", "month,region,revenue\n2026-01,east,120\n2026-01,west,80\n2026-02,east,135\n2026-02,west,95\n2026-03,east,150\n2026-03,west,90\n")),
];

export const taskById = (id: string): AbTask | undefined => TASKS.find((t) => t.id === id) ?? SKILL_TASKS.find((t) => t.id === id);
