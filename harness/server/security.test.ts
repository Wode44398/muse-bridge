import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { allowedBrowserOrigin, apiRequestAuthorized } from "./api-auth.ts";
import { checkpointDiff, rollbackTo, takeCheckpoint } from "./checkpoints.ts";
import { Sandbox } from "./sandbox.ts";
import { childEnv, commandCanVerify, commandScopeViolation, deniedCommand } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type { ToolContext } from "./tools/types.ts";
import type { PersistedSession } from "./store.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// 基线来自 test-setup.ts 的全局临时目录——还原而不是 delete，否则后续用例落回生产 sessions/。
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DIMENSIO_CHILD_ENV_ALLOW;
  delete process.env.DIMENSIO_READONLY_PATHS;
  delete process.env.SAFE_CHILD_VALUE;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function request(origin: string | undefined, token?: string) {
  return {
    method: "GET",
    query: {},
    get(name: string) {
      if (name.toLowerCase() === "origin") return origin;
      if (name.toLowerCase() === "x-dimensio-internal-token") return token;
      return undefined;
    },
  } as any;
}

// S1 之后：白名单 Origin 只决定 CORS 能不能读响应，不再免令牌放行（详见 control-plane.test.ts）。
test("harness API authorizes only the token; the dev-UI origin list is CORS-only", () => {
  const configured = new Set<string>();
  const dev = allowedBrowserOrigin("http://localhost:5178", 8799, configured);
  assert.equal(dev, "http://localhost:5178");
  assert.equal(allowedBrowserOrigin("https://attacker.example", 8799, configured), null);
  assert.equal(apiRequestAuthorized(request(dev!), "bridge-secret"), false);
  assert.equal(apiRequestAuthorized(request(dev!, "bridge-secret"), "bridge-secret"), true);
  assert.equal(apiRequestAuthorized(request("https://attacker.example"), "bridge-secret"), false);
  assert.equal(apiRequestAuthorized(request("https://attacker.example", "bridge-secret"), "bridge-secret"), true);
});

test("workspace Bash policy blocks direct escapes and credential paths", () => {
  const root = temp("dimensio-bash-root-");
  const outside = path.join(path.dirname(root), "outside.txt");
  assert.match(commandScopeViolation("cd ..", root, "workspace")!, /parent-directory/);
  assert.match(commandScopeViolation("cd ..; pwd", root, "workspace")!, /parent-directory/);
  assert.match(commandScopeViolation("cat .env", root, "workspace")!, /credential/);
  assert.match(commandScopeViolation(`type ${outside}`, root, "workspace")!, /escapes the workspace/);
  assert.equal(commandScopeViolation(`type "${path.join(root, "sub folder", "file.txt")}"`, root, "workspace"), null);
  assert.equal(commandScopeViolation("npm test", root, "workspace"), null);
  assert.equal(commandScopeViolation("git status", root, "workspace"), null);
  assert.equal(commandCanVerify("git status"), false);
  assert.equal(commandCanVerify("echo done"), false);
  assert.equal(commandCanVerify("npm test"), true);
});

test("workspace Bash policy allows `..` that stays inside the workspace", () => {
  const root = temp("dimensio-bash-dotdot-");
  // 2026-08-09 real-world false positives: cd into a subdir, then reference the
  // parent (still inside the workspace) — with and without a heredoc in between.
  assert.equal(commandScopeViolation('cd sub/dir && cat "../file.md"', root, "workspace"), null);
  assert.equal(commandScopeViolation("cd sub/dir && cd .. && ls", root, "workspace"), null);
  assert.equal(
    commandScopeViolation(
      `cd cpu_report/data && PYTHONIOENCODING=utf-8 python - <<'EOF'\nimport pandas as pd\nprint('ok')\nEOF\ntest -s "../CPU report.md"`,
      root,
      "workspace",
    ),
    null,
  );
  // Actual escapes are still blocked, including past a dynamic cd.
  assert.match(commandScopeViolation("cd sub && cat ../../outside.txt", root, "workspace")!, /parent-directory/);
  assert.match(commandScopeViolation('cd "$DIR" && cat ../x', root, "workspace")!, /parent-directory/);
  assert.match(commandScopeViolation("cat ../outside.txt", root, "workspace")!, /parent-directory/);
  // Range/version tokens containing dots are not paths.
  assert.equal(commandScopeViolation("git log HEAD..main --oneline", root, "workspace"), null);

  // 2026-08-16 (k3 run): a quoted span can be a whole command line, where the
  // contained `..` path and an unexpandable `$VAR` are different WORDS — the $
  // must not condemn a path that stays inside.
  assert.equal(
    commandScopeViolation('cd sub && cmd //c "..\\.sdk\\bin\\aapt.exe dump badging $APK"', root, "workspace"),
    null,
  );
  assert.match(
    commandScopeViolation('cd sub && cmd //c "..\\..\\outside\\aapt.exe dump $APK"', root, "workspace")!,
    /parent-directory/,
  );
  // A quoted path that merely CONTAINS spaces is still judged as one path.
  assert.equal(commandScopeViolation('cd sub && cat "../my docs/notes.md"', root, "workspace"), null);
  assert.match(
    commandScopeViolation('cd sub && cat "../../my docs/notes.md"', root, "workspace")!,
    /parent-directory/,
  );
});

test("child commands do not inherit provider credentials", () => {
  process.env.OPENAI_API_KEY = "sk-test-secret-value";
  process.env.SAFE_CHILD_VALUE = "visible";
  process.env.DIMENSIO_CHILD_ENV_ALLOW = "SAFE_CHILD_VALUE";
  const env = childEnv();
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SAFE_CHILD_VALUE, "visible");
  assert.ok(env.PATH || env.Path);
  assert.notEqual(env.HOME, process.env.HOME);
  assert.notEqual(env.USERPROFILE, process.env.USERPROFILE);
});

test("partial Read cannot unlock a whole-file Write", async () => {
  const root = temp("dimensio-read-gate-");
  const file = path.join(root, "large.txt");
  const original = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
  fs.writeFileSync(file, original, "utf8");
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };

  assert.equal((await readTool.run({ path: "large.txt", limit: 1 }, ctx)).ok, true);
  const blocked = await writeTool.run({ path: "large.txt", content: "replacement" }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /not fully read/);
  assert.equal(fs.readFileSync(file, "utf8"), original);

  assert.equal((await readTool.run({ path: "large.txt", offset: 2, limit: 4000 }, ctx)).ok, true);
  assert.equal((await writeTool.run({ path: "large.txt", content: "replacement" }, ctx)).ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), "replacement");
});

test("checkpoint trees never contain credential files", async () => {
  const root = temp("dimensio-checkpoint-work-");
  const sessions = temp("dimensio-checkpoint-state-");
  process.env.SESSIONS_DIR = sessions;
  fs.writeFileSync(path.join(root, "source.txt"), "safe", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=do-not-store", "utf8");
  fs.writeFileSync(path.join(root, "private.pem"), "do-not-store", "utf8");

  const rec: PersistedSession = {
    v: 1,
    id: "security-checkpoint",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "security",
    config: {
      provider: "openai",
      model: "fake",
      thinking: "off",
      permissionMode: "auto",
      workspace: root,
      access: "workspace",
    },
    system: "test",
    messages: [],
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
  const cp = await takeCheckpoint(rec, root, "before security test");
  assert.ok(cp);
  const listed = spawnSync(
    "git",
    [`--git-dir=${path.join(sessions, "shadow.git")}`, "ls-tree", "-r", "--name-only", cp!.hash],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /source\.txt/);
  assert.doesNotMatch(listed.stdout, /\.env|private\.pem/);

  fs.writeFileSync(path.join(root, "source.txt"), "changed", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=new-secret", "utf8");
  const diff = await checkpointDiff(rec.id, cp!.n, root);
  assert.match(diff, /source\.txt/);
  assert.doesNotMatch(diff, /new-secret|do-not-store|private\.pem|\.env/);

  await rollbackTo(rec.id, cp!.n, root);
  assert.equal(fs.readFileSync(path.join(root, "source.txt"), "utf8"), "safe");
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "OPENAI_API_KEY=new-secret");
});

test("an explicitly opened directory is readable, never writable, and only by a plain read", () => {
  const root = temp("dimensio-readonly-work-");
  const opened = temp("dimensio-readonly-open-");
  const other = temp("dimensio-readonly-other-");
  fs.writeFileSync(path.join(opened, "release"), "jdk21", "utf8");

  // Nothing is opened by default — the refusal just names a way forward now,
  // instead of being the dead end that sent a k3 run guessing via gradlew.
  const closed = commandScopeViolation(`ls "${opened}"`, root, "workspace");
  assert.match(closed!, /escapes the workspace/);
  assert.match(closed!, /full access|DIMENSIO_READONLY_PATHS/);

  process.env.DIMENSIO_READONLY_PATHS = opened;
  assert.equal(commandScopeViolation(`ls "${opened}"`, root, "workspace"), null);
  assert.equal(commandScopeViolation(`ls "${opened}" 2>/dev/null | grep -i jdk`, root, "workspace"), null);
  // Writes and anything that is not a plain read stay out.
  assert.match(commandScopeViolation(`echo x > "${opened}/f.txt"`, root, "workspace")!, /reading only/);
  assert.match(commandScopeViolation(`python "${opened}/setup.py"`, root, "workspace")!, /read-only command/);
  // Opening one directory opens nothing else.
  assert.match(commandScopeViolation(`ls "${other}"`, root, "workspace")!, /escapes the workspace/);

  // File tools follow the same split: reads resolve, writes are refused.
  const sandbox = new Sandbox(root, "workspace");
  assert.equal(sandbox.resolve(path.join(opened, "release")), path.resolve(opened, "release"));
  assert.throws(() => sandbox.resolve(path.join(opened, "release"), { forWrite: true }), /reading only/);
});

test("key material is judged by location, credential stores by name", () => {
  const root = temp("dimensio-key-work-");
  const outsidePem = path.join(path.dirname(root), "prod.pem");
  const sandbox = new Sandbox(root, "workspace");
  const full = new Sandbox(root, "full");

  // A .pem/.key the agent made or found INSIDE the workspace is an ordinary file
  // (2026-08-16: refusing these cost a k3 run its only route to a public key).
  assert.equal(sandbox.resolve("certs/dev.key", { forWrite: true }), path.resolve(root, "certs/dev.key"));
  assert.equal(commandScopeViolation("openssl rsa -in certs/dev.key -pubout", root, "workspace"), null);

  // Outside the workspace it stays blocked — in BOTH access modes.
  assert.throws(() => full.resolve(outsidePem), /secret guard/);
  assert.match(commandScopeViolation(`cat "${outsidePem}"`, root, "full")!, /secret guard/);
  assert.match(commandScopeViolation(`cat "${outsidePem}"`, root, "workspace")!, /secret guard/);

  // Named credential stores are blocked everywhere, workspace-relative included.
  assert.throws(() => sandbox.resolve(".env"), /secret guard/);
  assert.match(commandScopeViolation("cat .ssh/id_rsa", root, "workspace")!, /credential store/);
});

test("a literal ~ path is resolved and judged, not refused on sight", () => {
  const root = temp("dimensio-home-");
  const homeChild = path.join(os.homedir(), ".gradle");

  // Unopened: blocked like any other outside path, with the same way forward.
  assert.match(commandScopeViolation("ls ~/.gradle", root, "workspace")!, /escapes the workspace/);
  // Opened: a plain read gets through.
  process.env.DIMENSIO_READONLY_PATHS = homeChild;
  assert.equal(commandScopeViolation("ls ~/.gradle 2>/dev/null | head", root, "workspace"), null);
  // The shell-expanded forms remain unresolvable, so they remain refused.
  assert.match(commandScopeViolation("ls $HOME/.gradle", root, "workspace")!, /home-directory variables/);
});

test("the host deny-list does not govern the phone on the other end of adb shell", () => {
  // Device-side cleanup is ordinary Android work; it used to read as "rm -rf /"
  // on this machine and got refused outright.
  assert.equal(deniedCommand(".sdk/platform-tools/adb.exe shell rm -rf /data/local/tmp/probe"), null);
  assert.equal(deniedCommand("adb shell rm -rf /sdcard/Android/data/com.podstream.air/cache"), null);
  assert.equal(deniedCommand("adb -s 192.168.1.7:5555 shell rm -rf /data/local/tmp/x"), null);

  // The host is still protected — including when a device command is chained
  // ahead of a host one.
  assert.ok(deniedCommand("rm -rf /"));
  assert.ok(deniedCommand("adb shell rm -rf /data/local/tmp/x; rm -rf ~"));
  assert.ok(deniedCommand("shutdown /s /t 0"));
  // adb itself, without shell, is a host command like any other.
  assert.ok(deniedCommand("adb push x /sdcard/ && rm -rf $HOME"));
});
