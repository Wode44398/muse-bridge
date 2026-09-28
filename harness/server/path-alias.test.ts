// S6（#23、#17）回归：
//   · UNC（\\host\share、git-bash 的 //host/share）与 NT/设备命名空间（\\?\、\\.\）两种模式都拒；
//   · 工作区里指到外面的 junction：字面在里面、真实落点在外面，Read/Write/Bash 都按真实落点判。
// 探针原型：竞品拆解/03-hermes-agent/笔记/probe-selfkill-unc.ts 的 #20 段（修前 workspace 模式全部放行）；
// #17 修前 sandbox.ts 全文件没有 realpath。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { Sandbox } from "./sandbox.ts";
import { commandScopeViolation } from "./tools/bash.ts";

let tmp = "";
let ws = "";
let outside = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s6-"));
  ws = path.join(tmp, "ws");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(outside, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(outside, "notes.txt"), "outside\n");
  fs.writeFileSync(path.join(outside, ".ssh", "known_hosts"), "host key\n");
  // mklink /J 等价物：Windows 上 junction 不需要管理员权限。
  fs.symlinkSync(outside, path.join(ws, "link"), "junction");
  fs.symlinkSync(path.join(outside, ".ssh"), path.join(ws, "keys"), "junction");
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const refuses = (sb: Sandbox, p: string, forWrite = false) => {
  try {
    sb.resolve(p, { forWrite });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

test("S6: UNC, NT-namespace and device paths are refused in both access modes", () => {
  for (const access of ["workspace", "full"] as const) {
    const sb = new Sandbox(ws, access);
    for (const p of [
      "\\\\localhost\\c$\\Windows\\win.ini",
      "//localhost/c$/Windows/win.ini",
      "\\\\evil.example\\share\\x.txt",
      "\\\\?\\C:\\Windows\\win.ini",
      "//?/C:/Windows/win.ini",
      "\\\\.\\PhysicalDrive0",
      "CON",
      "sub/nul",
    ]) {
      assert.ok(refuses(sb, p), `${access}: ${p}`);
    }
    assert.equal(refuses(sb, "src/index.ts"), null, `${access}: an ordinary path`);
  }
});

test("S6: Bash sees UNC / NT spellings anywhere in the command (probe #20 cases)", () => {
  for (const cmd of [
    "cat //localhost/c$/Windows/win.ini",
    "cmd //c type \\\\localhost\\c$\\Windows\\win.ini",
    "cat '\\\\?\\C:\\Windows\\win.ini'",
    "cd //localhost/c$ && cat Windows/win.ini",
    "cat \\\\evil.example\\share\\x.txt",
  ]) {
    for (const access of ["workspace", "full"] as const) {
      assert.ok(commandScopeViolation(cmd, ws, access), `${access}: ${cmd}`);
    }
  }
  // git-bash 的 //c 是 cmd 的 /c 开关转义，不是 UNC；2>nul 是常见重定向。
  assert.equal(commandScopeViolation("cmd //c dir", ws, "workspace"), null);
  assert.equal(commandScopeViolation("npm test 2>nul", ws, "workspace"), null);
});

test("S6: a junction inside the workspace cannot carry Read/Write/Bash outside (#17)", () => {
  const sb = new Sandbox(ws, "workspace");
  assert.match(refuses(sb, "link/notes.txt") ?? "", /link or junction/);
  assert.match(refuses(sb, "link/new.txt", true) ?? "", /escapes|link or junction/);
  assert.match(commandScopeViolation("cat link/notes.txt", ws, "workspace") ?? "", /link or junction/);
  assert.match(commandScopeViolation("cd link", ws, "workspace") ?? "", /link or junction/);
  // 整机模式放行越界，但凭据判定照样按真实落点：keys → outside/.ssh。
  const full = new Sandbox(ws, "full");
  assert.equal(refuses(full, "link/notes.txt"), null);
  assert.match(refuses(full, "keys/known_hosts") ?? "", /secret guard/);
  // 工作区里的普通文件不受影响。
  fs.writeFileSync(path.join(ws, "a.txt"), "x");
  assert.equal(refuses(sb, "a.txt"), null);
  assert.equal(commandScopeViolation("cat a.txt", ws, "workspace"), null);
});
