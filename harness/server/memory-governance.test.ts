// K4（G5）：记忆治理——按项目看、确认（晋升）、驳回、撤销驳回；/api/memory 按工作区。
//
// 修前：界面完全不调 /api/memory，模型存的 proposed 条目永远进不了提示、错的 active 条目也没处驳回；接口一律绑在
// 全局 workspaceRoot()，多项目时读写的是别的项目的桶；也没有「驳回」这回事——模型下一轮还能把同样的错结论存回来。
// 修后：promote / reject / restore；rejected 状态只能由界面设置，Remember 覆盖不了、删不掉，同 topic 另存时会被提醒；
// /api/memory* 认 ?workspace= / body.workspace，没有记忆的项目回空、不建目录。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import {
  listMemories,
  memoryDir,
  MemoryTopicConflict,
  promoteMemory,
  readMemory,
  rejectMemory,
  renderMemoryForPrompt,
  restoreMemory,
  saveMemory,
} from "./memory.ts";
import { Sandbox } from "./sandbox.ts";
import { killTree } from "./tools/bash.ts";
import { recallTool } from "./tools/recall.ts";
import { rememberTool } from "./tools/remember.ts";
import type { ToolContext } from "./tools/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "k4-DUMMY-token";
const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(prefix = "dimensio-k4-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const text = (r: { content: Array<{ t: string; text?: string }> }) => r.content.map((b) => b.text ?? "").join("\n");

// 模型存的待确认条目：项目类、没有 Why / How to apply（待确认允许，生效不行）
function proposeNote(ws: string, title: string, topic: string, content = "构建要用 JDK 17。") {
  return saveMemory(ws, {
    title,
    description: `${title} 的说明`,
    type: "project",
    topic,
    status: "proposed",
    confidence: "observed",
    evidence: ["gradle --version"],
    content,
    origin: { writer: "model", attended: true },
  }).id;
}
const WHY = "构建要用 JDK 17。\n\nWhy: 升级到 AGP 9 之后 JDK 11 编不过。\n\nHow to apply: 本机 JAVA_HOME 指向 JDK 17 再跑 gradle。";

test("K4 晋升 / 驳回 / 撤销驳回：确认 = active + user_confirmed；校验不过一次报全；同 topic 要替换；驳回带理由、提示里单独说", () => {
  const ws = workspace();
  const id = proposeNote(ws, "android build jdk", "android.build.jdk");
  assert.equal(readMemory(ws, id)?.status, "proposed");
  assert.doesNotMatch(renderMemoryForPrompt(ws) ?? "", /android build jdk/, "待确认的进不了提示");

  // 缺 Why / How to apply：两条一起报，不是挤牙膏
  assert.throws(() => promoteMemory(ws, id), (e: Error) => /Why: section/.test(e.message) && /How to apply: section/.test(e.message));
  promoteMemory(ws, id, { edits: { content: WHY } });
  const promoted = readMemory(ws, id)!;
  assert.equal(promoted.status, "active");
  assert.equal(promoted.confidence, "user_confirmed");
  assert.equal(promoted.origin, "user");
  assert.match(renderMemoryForPrompt(ws) ?? "", /android build jdk/, "确认后进提示");

  // 同一个 topic 再确认一条：先报冲突（带是哪条），带 supersedes 才替换
  const id2 = proposeNote(ws, "android build jdk 21", "android.build.jdk", WHY.replace("17", "21"));
  assert.throws(
    () => promoteMemory(ws, id2),
    (e: unknown) => e instanceof MemoryTopicConflict && e.conflicts.length === 1 && e.conflicts[0].id === id,
  );
  promoteMemory(ws, id2, { supersedes: id });
  assert.equal(readMemory(ws, id)?.status, "superseded");
  assert.equal(readMemory(ws, id2)?.status, "active");

  // 驳回：带理由；提示里不列它，单独说一句「用户驳回过 N 条」
  assert.equal(rejectMemory(ws, id2, "这是猜的，实际用的是 17"), true);
  const rejected = readMemory(ws, id2)!;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectReason, "这是猜的，实际用的是 17");
  assert.ok(rejected.rejectedAt);
  const prompt = renderMemoryForPrompt(ws) ?? "";
  assert.doesNotMatch(prompt, /android build jdk 21/);
  assert.match(prompt, /1 notes the user rejected are omitted/);

  // 撤销驳回：回到待确认，驳回记录清掉
  assert.equal(restoreMemory(ws, id2), true);
  const back = readMemory(ws, id2)!;
  assert.equal(back.status, "proposed");
  assert.equal(back.rejectReason, undefined);
  assert.equal(restoreMemory(ws, id2), false, "不是驳回状态就没得撤销");

  // 每一步的旧版都进 .history；rejected 只能由界面设，存不进来
  const history = fs.readdirSync(path.join(memoryDir(ws), ".history")).join("\n");
  assert.match(history, /\.reject\.md/);
  assert.match(history, /\.restore\.md/);
  assert.throws(
    () => saveMemory(ws, { title: "x", description: "x", type: "reference", topic: "x", status: "rejected", confidence: "observed", evidence: ["e"], content: "x" }),
    /set only by the user/,
  );
});

// 用户驳回过的条目：直接改文件造出来（不依赖新导出，修前的代码也能读这个文件）
function rejectOnDisk(ws: string, id: string, reason: string) {
  const file = path.join(memoryDir(ws), `${id}.md`);
  const raw = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, raw.replace(/^status: \w+$/m, `status: rejected\nrejected_at: "2026-09-24T00:00:00.000Z"\nreject_reason: ${JSON.stringify(reason)}`));
}

test("K4 模型动不了用户驳回的条目：Remember 覆盖、删除都拒绝；同 topic 另存一条时提醒；Recall 显示驳回理由", async () => {
  const ws = workspace();
  const ctx: ToolContext = {
    sandbox: new Sandbox(ws, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
    agentSeesImages: false,
  };
  const id = proposeNote(ws, "grep chinese filenames", "tools.grep.cjk");
  rejectOnDisk(ws, id, "Grep 支持中文文件名，是模型看错了");

  const again = await rememberTool.run(
    { title: "grep chinese filenames", description: "d", type: "project", topic: "tools.grep.cjk", status: "proposed", confidence: "observed", evidence: ["x"], content: "Grep 不支持中文文件名" },
    ctx,
  );
  assert.equal(again.ok, false, "不许把用户驳回的同一条再存回来");
  assert.match(text(again), /the user rejected memory \[grep-chinese-filenames\].*Grep 支持中文文件名/);
  assert.equal(readMemory(ws, id)?.declaredStatus, "rejected");

  const del = await rememberTool.run({ action: "delete", id }, ctx);
  assert.equal(del.ok, false, "删不掉用户的决定记录");
  assert.ok(fs.existsSync(path.join(memoryDir(ws), `${id}.md`)));

  const sibling = await rememberTool.run(
    { title: "grep cjk paths", description: "d", type: "project", topic: "tools.grep.cjk", status: "proposed", confidence: "observed", evidence: ["x"], content: "另一条" },
    ctx,
  );
  assert.equal(sibling.ok, true, text(sibling));
  assert.match(text(sibling), /the user rejected memory \[grep-chinese-filenames\].*on this same topic/);

  const recalled = await recallTool.run({ id }, ctx);
  assert.match(text(recalled), /REJECTED by the user.*Grep 支持中文文件名，是模型看错了/);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("K4 /api/memory 按工作区：?workspace= 读写那个项目的桶；没记忆的项目回空不建目录；不给还是全局；晋升冲突 409", { timeout: 90_000 }, async () => {
  const globalWs = workspace("dimensio-k4-global-");
  const projB = workspace("dimensio-k4-b-");
  const projC = workspace("dimensio-k4-c-");
  const idB = proposeNote(projB, "b build jdk", "b.build.jdk");

  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(here, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "",
      DIMENSIO_DEV_TOKEN: TOKEN,
      DIMENSIO_OUTBOUND_PROXY: "off",
      WORKSPACE_DIR: globalWs,
      BRIDGE_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
  const get = async (p: string) => {
    const r = await fetch(base + p, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const q = (ws: string) => `workspace=${encodeURIComponent(ws)}`;
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`${base}/api/info`, { headers });
        await r.arrayBuffer();
        if (r.status === 200) break;
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }

    // 按工作区读（修前 ?workspace= 被无视，读到的是全局那个空桶）
    const listB = await get(`/api/memory?${q(projB)}`);
    assert.equal(listB.status, 200);
    assert.deepEqual(listB.body.map((m: { id: string }) => m.id), [idB], "读的是 B 项目的记忆");
    assert.deepEqual((await get("/api/memory")).body, [], "不给 workspace = 全局工作区（老客户端不变）");
    assert.deepEqual((await get(`/api/memory?${q(projC)}`)).body, []);
    assert.equal(fs.existsSync(memoryDir(projC)), false, "只是看一眼，不为没有记忆的项目建目录");
    assert.equal((await get(`/api/memory?workspace=relative/dir`)).status, 400);
    assert.equal((await get(`/api/memory?${q(path.join(projB, "no-such-dir"))}`)).status, 400);
    assert.equal((await get(`/api/memory/${idB}?${q(projB)}`)).body.id, idB);

    // 晋升：缺 Why / How to apply → 400 把问题带回来；带改动 → 200，落在 B 的桶里
    const bad = await post(`/api/memory/${idB}/promote`, { workspace: projB });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Why: section/);
    const good = await post(`/api/memory/${idB}/promote`, { workspace: projB, edits: { content: WHY } });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(readMemory(projB, idB)?.status, "active");
    assert.deepEqual(listMemories(globalWs), [], "全局工作区的桶没被写");

    // 同 topic 再确认一条 → 409 带冲突；带 supersedes → 200
    const idB2 = proposeNote(projB, "b build jdk 21", "b.build.jdk", WHY);
    const conflict = await post(`/api/memory/${idB2}/promote`, { workspace: projB });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.conflicts.map((c: { id: string }) => c.id), [idB]);
    assert.equal((await post(`/api/memory/${idB2}/promote`, { workspace: projB, supersedes: idB })).status, 200);

    // 驳回 → 撤销 → 删除，都在 B 的桶里
    assert.equal((await post(`/api/memory/${idB2}/reject`, { workspace: projB, reason: "不对" })).status, 200);
    assert.equal(readMemory(projB, idB2)?.rejectReason, "不对");
    assert.equal((await post(`/api/memory/${idB2}/restore`, { workspace: projB })).status, 200);
    assert.equal(readMemory(projB, idB2)?.status, "proposed");
    assert.deepEqual((await post(`/api/memory/${idB2}/delete`, { workspace: projB })).body, { deleted: true });
    assert.equal(readMemory(projB, idB2), undefined);
  } finally {
    killTree(child);
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
  }
});
