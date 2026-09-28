// Q8（X47 / N38 / K04）：数据位置收口到 paths.ts + 解析点的测试隔离守卫 + test-setup 无条件改道。
// #14 本身（删掉 MEMORY_DIR / KNOWLEDGE_DIR 后写入回落到生产目录）的回归在 test-pollution.test.ts。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bridgeRootCandidates,
  configFile,
  defaultWorkspace,
  envFile,
  globalGuideFile,
  inTestProcess,
  knowledgeRoot,
  memoryRoot,
  projectsFile,
  projectsRoot,
  quickFile,
  quickRoot,
  sessionsDir,
  underTmp,
} from "./paths.ts";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(serverDir, "..");
const pathsUrl = pathToFileURL(path.join(serverDir, "paths.ts")).href;

const DATA_VARS = [
  "SESSIONS_DIR", "MEMORY_DIR", "KNOWLEDGE_DIR", "DIMENSIO_CONFIG_FILE", "DIMENSIO_QUICK_FILE", "DIMENSIO_QUICK_ROOT",
  "PROJECTS_FILE", "PROJECTS_ROOT", "WORKSPACE_DIR", "DIMENSIO_GLOBAL_GUIDE", "HARNESS_ENV_FILE",
] as const;

const RESOLVERS: Record<string, () => string> = {
  SESSIONS_DIR: sessionsDir,
  MEMORY_DIR: memoryRoot,
  KNOWLEDGE_DIR: knowledgeRoot,
  DIMENSIO_CONFIG_FILE: configFile,
  DIMENSIO_QUICK_FILE: quickFile,
  DIMENSIO_QUICK_ROOT: quickRoot,
  PROJECTS_FILE: projectsFile,
  PROJECTS_ROOT: projectsRoot,
  WORKSPACE_DIR: defaultWorkspace,
  DIMENSIO_GLOBAL_GUIDE: globalGuideFile,
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 起一个「干净」的 node 子进程：不带测试标记、不带任何数据位置变量，就像生产里 bridge 拉起 harness。
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.DIMENSIO_TEST_ISOLATION;
  for (const name of [...DATA_VARS, "BRIDGE_DATA_ROOT", "BRIDGE_ROOT"]) delete env[name];
  return { ...env, ...extra };
}

function runNode(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): unknown {
  const r = spawnSync(process.execPath, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(r.status, 0, `子进程失败：${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

test("Q8 测试进程里：数据位置不在临时目录下就抛错——没设（默认即生产位置）和显式指向生产位置都不认", () => {
  assert.equal(inTestProcess(), true);
  const prodLike: Record<string, string> = {
    SESSIONS_DIR: path.join(harnessRoot, "sessions"),
    MEMORY_DIR: path.join(harnessRoot, "memory"),
    KNOWLEDGE_DIR: path.join(harnessRoot, "knowledge"),
    DIMENSIO_CONFIG_FILE: path.join(harnessRoot, "runtime-config.json"),
    DIMENSIO_QUICK_FILE: path.join(harnessRoot, "quick.json"),
    DIMENSIO_QUICK_ROOT: path.join(os.homedir(), ".dimensio", "quick"),
    PROJECTS_FILE: path.join(harnessRoot, "projects.json"),
    PROJECTS_ROOT: path.join(os.homedir(), "Dimensio Projects"),
    WORKSPACE_DIR: path.join(harnessRoot, "workspace"),
    DIMENSIO_GLOBAL_GUIDE: path.join(os.homedir(), ".dimensio", "GUIDE.md"),
  };
  for (const [name, resolve] of Object.entries(RESOLVERS)) {
    withEnv({ [name]: undefined }, () => {
      assert.throws(resolve, /测试进程解析到了临时目录之外/, `${name} 没设时应当拒绝（默认值就是生产位置）`);
    });
    withEnv({ [name]: prodLike[name] }, () => {
      assert.throws(resolve, /测试进程解析到了临时目录之外/, `${name} 显式指向生产位置也应当拒绝`);
    });
    const tmp = path.join(os.tmpdir(), `dimensio-q8-${name.toLowerCase()}`);
    withEnv({ [name]: tmp }, () => {
      assert.equal(resolve(), path.resolve(tmp), `${name} 指到临时目录下应当照常解析`);
    });
  }
  // 临时目录本身不算「在临时目录下」。
  assert.equal(underTmp(os.tmpdir()), false);
  assert.equal(underTmp(path.join(os.tmpdir(), "x")), true);
});

test("Q8 测试进程不加载生产 .env，也不认临时目录之外的 bridge 数据根", () => {
  withEnv({ HARNESS_ENV_FILE: undefined }, () => assert.equal(envFile(), null));
  withEnv({ HARNESS_ENV_FILE: path.join(harnessRoot, ".env") }, () => assert.equal(envFile(), null));
  const tmpEnv = path.join(os.tmpdir(), "dimensio-q8-env", "x.env");
  withEnv({ HARNESS_ENV_FILE: tmpEnv }, () => assert.equal(envFile(), path.resolve(tmpEnv)));

  const tmpRoot = path.join(os.tmpdir(), "dimensio-q8-bridge-data");
  withEnv({ BRIDGE_DATA_ROOT: tmpRoot, BRIDGE_ROOT: path.resolve(harnessRoot, "..") }, () => {
    // harness/ 的上级（开发时的 bridge 根）与显式给的非临时根都被滤掉，只剩临时目录下那个。
    assert.deepEqual(bridgeRootCandidates(), [path.resolve(tmpRoot)]);
    assert.deepEqual(bridgeRootCandidates({ withHarnessDir: true }), [path.resolve(tmpRoot)]);
  });
  withEnv({ BRIDGE_DATA_ROOT: undefined, BRIDGE_ROOT: undefined }, () => {
    assert.deepEqual(bridgeRootCandidates({ withHarnessDir: true }), []);
  });
});

test("Q8 生产进程（无测试标记）里解析结果与收口前一致：环境变量优先，否则按 cwd 与家目录回落", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q8-prod-cwd-"));
  try {
    const script = `
      const p = await import(process.argv[1]);
      console.log(JSON.stringify({
        inTest: p.inTestProcess(), sessions: p.sessionsDir(), memory: p.memoryRoot(), knowledge: p.knowledgeRoot(),
        config: p.configFile(), quickFile: p.quickFile(), quickRoot: p.quickRoot(), projectsFile: p.projectsFile(),
        projectsRoot: p.projectsRoot(), workspace: p.defaultWorkspace(), guide: p.globalGuideFile(), env: p.envFile(),
        bridge: p.bridgeRootCandidates(), bridgeWithHarness: p.bridgeRootCandidates({ withHarnessDir: true }),
      }));`;
    const got = runNode(["--input-type=module", "-e", script, pathsUrl], { cwd, env: cleanEnv() }) as Record<string, unknown>;
    const real = fs.realpathSync(cwd);
    const base = (got.sessions as string).slice(0, -"sessions".length - 1); // cwd 可能被解析成长名
    assert.equal(fs.realpathSync(base), real);
    assert.deepEqual(got, {
      inTest: false,
      sessions: path.join(base, "sessions"),
      memory: path.join(base, "memory"),
      knowledge: path.join(base, "knowledge"),
      config: path.join(base, "runtime-config.json"),
      quickFile: path.join(base, "quick.json"),
      quickRoot: path.join(os.homedir(), ".dimensio", "quick"),
      projectsFile: path.join(base, "projects.json"),
      projectsRoot: path.join(os.homedir(), "Dimensio Projects"),
      workspace: path.join(base, "workspace"),
      guide: path.join(os.homedir(), ".dimensio", "GUIDE.md"),
      env: path.join(base, ".env"),
      bridge: [path.dirname(base)],
      bridgeWithHarness: [base, path.dirname(base)],
    });

    // 显式给的值原样生效（生产里不看在不在临时目录）。
    const elsewhere = path.resolve(harnessRoot, "..", "q8-explicit-sessions");
    const explicit = runNode(
      ["--input-type=module", "-e", "const p = await import(process.argv[1]); console.log(JSON.stringify([p.sessionsDir(), p.bridgeRootCandidates()]));", pathsUrl],
      { cwd, env: cleanEnv({ SESSIONS_DIR: elsewhere, BRIDGE_DATA_ROOT: harnessRoot }) },
    ) as [string, string[]];
    assert.equal(explicit[0], elsewhere);
    assert.equal(explicit[1][0], harnessRoot);
    assert.equal(fs.existsSync(elsewhere), false, "只解析，不创建");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Q8 env.ts：生产进程照常加载 .env；测试进程只加载显式指到临时目录下的那份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q8-envload-"));
  try {
    fs.writeFileSync(path.join(dir, ".env"), "Q8_FAKE_ENV_VALUE=FAKE-loaded\n");
    const envUrl = pathToFileURL(path.join(serverDir, "env.ts")).href;
    const script = "await import(process.argv[1]); console.log(JSON.stringify(process.env.Q8_FAKE_ENV_VALUE ?? null));";
    const run = (env: NodeJS.ProcessEnv) => runNode(["--input-type=module", "-e", script, envUrl], { cwd: dir, env });
    assert.equal(run(cleanEnv()), "FAKE-loaded", "生产：cwd 下的 .env 照常加载");
    assert.equal(run(cleanEnv({ DIMENSIO_TEST_ISOLATION: "1" })), null, "测试进程：不按 cwd 回落去加载 .env");
    assert.equal(
      run(cleanEnv({ DIMENSIO_TEST_ISOLATION: "1", HARNESS_ENV_FILE: path.join(dir, ".env") })),
      "FAKE-loaded",
      "测试进程：显式指到临时目录下的照常加载",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Q8 test-setup：无条件改道（shell 里继承来的生产路径也不认）、打标记、删掉继承来的凭据", () => {
  const script = `console.log(JSON.stringify({
    vars: Object.fromEntries(${JSON.stringify([...DATA_VARS])}.map((k) => [k, process.env[k] ?? null])),
    marker: process.env.DIMENSIO_TEST_ISOLATION ?? null,
    fakeKey: process.env.Q8_FAKE_API_KEY ?? null,
    fakeToken: process.env.DIMENSIO_INTERNAL_TOKEN ?? null,
    keep: process.env.Q8_PLAIN_SETTING ?? null,
  }));`;
  const got = runNode(["--import", "./server/test-setup.ts", "--input-type=module", "-e", script], {
    cwd: harnessRoot,
    env: cleanEnv({
      SESSIONS_DIR: path.join(harnessRoot, "sessions"), // 有人在 shell 里 export 了生产路径
      MEMORY_DIR: path.join(harnessRoot, "memory"),
      Q8_FAKE_API_KEY: "FAKE-q8-key",
      DIMENSIO_INTERNAL_TOKEN: "DUMMY-q8-token",
      Q8_PLAIN_SETTING: "kept",
    }),
  }) as { vars: Record<string, string | null>; marker: string | null; fakeKey: string | null; fakeToken: string | null; keep: string | null };
  assert.equal(got.marker, "1");
  for (const name of DATA_VARS) {
    const v = got.vars[name];
    assert.ok(v, `${name} 应当被改道`);
    assert.ok(underTmp(v!), `${name} 应当落在临时目录下：${v}`);
  }
  assert.equal(got.fakeKey, null, "继承来的 key 应当被删掉");
  assert.equal(got.fakeToken, null, "继承来的令牌应当被删掉");
  assert.equal(got.keep, "kept", "普通变量不动");
  // 子进程退出时整根删掉。
  const root = path.dirname(got.vars.SESSIONS_DIR!);
  assert.equal(fs.existsSync(root), false, `临时根应当随进程退出删掉：${root}`);
});

// N48 的 no-cwd-data-path：数据位置只在 paths.ts 解析。别处真需要 cwd 的，先想想是不是数据位置；确实不是，
// 就在这里加一条带理由的豁免。
test("Q8 守卫：server/ 下除 paths.ts 与测试文件外不出现 process.cwd()", () => {
  const skip = new Set(["paths.ts", "test-setup.ts", "test-global.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || skip.has(entry.name)) continue;
      fs.readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/(^|\s)\/\/.*$/, "$1"); // 去掉行尾注释（URL 里的 // 前面是冒号，不受影响）
        if (/process\.cwd\(\)/.test(code)) offenders.push(`${path.relative(serverDir, abs)}:${i + 1}`);
      });
    }
  };
  walk(serverDir);
  assert.deepEqual(offenders, [], "数据位置只在 server/paths.ts 解析（见该文件头）");
});
