// #98（规划外，U9 预览时照出来）：审计已经交过之后，模型一轮接一轮地只交审计、一个字不说——loop 没有上限。
//
// 修前：这些轮都是 internal（界面上只看得到活动行一直是「记忆审计」），重复熔断在有人在场时只提醒不停；预览里一个假模型
// 两分钟跑出了 5755 条消息。Remember / MemoryAudit 交替着转圈同样停不下来（Remember 落在审计之后会把「审计已交」拨回去）。
// 修后：这一轮里审计交成过一次之后，连着只交审计生命周期工具（MemoryAudit / Remember / Recall）、不说话的轮数超过上限就
// 以 redundant_audit_loop 收场；正常的「答复 → 交审计 → 收工」不受影响。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { REDUNDANT_AUDIT_MESSAGE, REDUNDANT_AUDIT_TURNS } from "./agent/loop.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { rememberTool } from "./tools/remember.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const audit = (id: string) => calls(call(id, "MemoryAudit", { decision: "none", reason: "nothing durable in this exchange" }));
const transcript = (session: ReturnType<typeof attachSession>) => JSON.stringify(session.state!.messages);

test("#98 审计交过之后还一直只交审计：有上限，以 redundant_audit_loop 收场", async (t) => {
  // 从头到尾每次都只交审计、不说话（id 各不相同）——先答复再交审计的会走「答复在前」那条收尾，不是这里要测的
  // 修前是死循环：脚本到第 60 次才开口，好让修前的红检有个头（修后远远到不了这里）
  const adapter = scripted(t).always((_turn, n) => (n > 60 ? say("终于说话了") : audit(`m${n}`)));
  const session = attachSession(adapter, tmp("dimensio-98-"), { memoryAudit: true });
  await send(session, "干点活");
  // 交成审计那一轮 + 之后的冗余轮；远小于修前的几千次
  assert.ok(adapter.callCount <= REDUNDANT_AUDIT_TURNS + 1, `called the model ${adapter.callCount} times`);
  assert.ok(transcript(session).includes("redundant_audit_loop"), "转录里如实写了为什么收场");
  assert.ok(REDUNDANT_AUDIT_MESSAGE.startsWith("redundant_audit_loop"));
});

test("#98 Remember / MemoryAudit 交替着转圈也停得下来", async (t) => {
  const note = (id: string) =>
    calls(call(id, "Remember", { title: `note ${id}`, content: "x", description: "y", type: "reference", topic: `misc.${id}`, status: "proposed", confidence: "observed", evidence: ["e"] }));
  const adapter = scripted(t).always((_turn, n) => (n > 60 ? say("终于说话了") : n % 2 ? audit(`m${n}`) : note(`r${n}`)));
  const session = attachSession(adapter, tmp("dimensio-98b-"), { memoryAudit: true, tools: [memoryAuditTool, rememberTool] });
  await send(session, "干点活");
  assert.ok(adapter.callCount <= REDUNDANT_AUDIT_TURNS + 3, `called the model ${adapter.callCount} times`);
  assert.ok(transcript(session).includes("redundant_audit_loop"));
});

test("#98 正常的「答复 → 交审计 → 收工」不受影响", async (t) => {
  const adapter = scripted(t).next(say("答复写好了"), audit("m1"));
  const session = attachSession(adapter, tmp("dimensio-98c-"), { memoryAudit: true });
  await send(session, "干点活");
  assert.equal(adapter.callCount, 2);
  assert.ok(!transcript(session).includes("redundant_audit_loop"));
});
