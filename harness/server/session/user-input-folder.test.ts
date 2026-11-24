import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "../sandbox.ts";
import { prepareUserInput } from "./user-input.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "dimensio-folder-ref-"));
const ws = path.join(tmp, "main-ws");
const otherWs = path.join(tmp, "other-ws");
const sshDir = path.join(tmp, ".ssh");
mkdirSync(ws, { recursive: true });
mkdirSync(otherWs, { recursive: true });
mkdirSync(sshDir, { recursive: true });

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function makeFakeSession() {
  const sandbox = new Sandbox(ws, "workspace");
  const granted: string[] = [];
  sandbox.setReadGrants(() => granted);
  const state = {
    readRoots: granted,
    grantReadRoots(dirs: string[]) {
      for (const d of dirs) if (!granted.includes(d)) granted.push(d);
    },
    ctx: {
      sandbox,
      agentSeesImages: false,
      agentSeesVideo: false,
      agentHearsAudio: false,
    },
  };
  return { id: "s-test", state } as any;
}

test("prepareUserInput：拖入外部工作空间目录自动授予只读，当前工作空间保留真实目录名，敏感目录照旧拦截", () => {
  const sess = makeFakeSession();
  const res = prepareUserInput(sess, "看看这两个工作空间", [ws + "/", otherWs + "/"]);

  assert.equal(res.attachments.length, 2);
  assert.equal(res.attachments[0].kind, "folder");
  assert.ok(res.attachments[0].path.endsWith("/main-ws/"), `expected main-ws path, got ${res.attachments[0].path}`);
  assert.equal(res.attachments[1].kind, "folder");
  assert.ok(res.attachments[1].path.endsWith("/other-ws/"), `expected other-ws path, got ${res.attachments[1].path}`);
  assert.ok(sess.state.readRoots.includes(path.resolve(otherWs)));

  // 凭据守卫目录不会被自动放行
  assert.throws(() => prepareUserInput(sess, "偷看", [sshDir + "/"]), /secret guard/i);
});
