// 11-13 回归：bridge 启动时先把 plugin-providers.json 写成空表（插件还没起来），dimensio 恰在这时读运行配置——
// 盘上选着的模型中心服务认不出来，以前当场退回 anthropic（没 Key、菜单里没有），设置页「模型服务」一栏是空的，
// 新对话也落在没 Key 的厂商上。现在：先记成待认领，那家一出现就换回来；这期间写盘不许把盘上的选择盖掉。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-pending-"));
const savedEnv = { ...process.env };
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
const pluginFile = path.join(dir, "plugin-providers.json");
fs.writeFileSync(pluginFile, JSON.stringify({ v: 2, providers: [] }));

const ID = "custom-abcd1234";
const choiceFile = process.env.DIMENSIO_CONFIG_FILE!;
const wsInit = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ws0-"));
fs.writeFileSync(
  choiceFile,
  JSON.stringify({
    v: 1,
    provider: ID,
    model: "qwen-next",
    thinking: "medium",
    permissionMode: "auto",
    workspace: wsInit,
    models: { [ID]: { model: "qwen-next", thinking: "medium" }, "custom-0000ffff": { model: "x", thinking: "high" } },
  }),
);

const { getConfig, setConfig, configWritesSettled } = await import("./config.ts");
const { setCustomSecretsForTests } = await import("./custom-providers.ts");
setCustomSecretsForTests({ readSecrets: () => ({}), writeSecrets: () => {} });

test.after(() => {
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = savedEnv.DIMENSIO_CUSTOM_PROVIDERS_DIR;
});

const service = {
  id: ID,
  name: "朋友的 vLLM",
  baseUrl: "http://127.0.0.1:30001/v1",
  protocol: "openai",
  authStyle: "none",
  headers: [],
  models: ["qwen-next"],
  modelSpecs: [{ id: "qwen-next", label: "Qwen Next", enabled: true, kind: "chat", thinking: "effort", efforts: [{ id: "low", name: "低", value: {} }, { id: "medium", name: "中", value: {} }, { id: "high", name: "高", value: {} }], effortDefault: "low" }],
  defaultModel: "qwen-next",
  createdAt: 0,
  plugin: { id: "p", name: "插件" },
  apiKey: "",
};

test("那家服务还没出现：先用兜底厂商，改别的设置也不把盘上的选择盖掉", async () => {
  assert.notEqual(getConfig().provider, ID);
  assert.equal(getConfig().workspace, path.resolve(wsInit), "上次选的工作空间重启后照旧");
  setConfig({ permissionMode: "plan" });
  await configWritesSettled();
  const disk = JSON.parse(fs.readFileSync(choiceFile, "utf8"));
  assert.equal(disk.provider, ID);
  assert.equal(disk.model, "qwen-next");
  assert.equal(disk.permissionMode, "plan");
  assert.equal(disk.models[ID]?.model, "qwen-next", "还没出现的服务的上次型号也得留着");
  assert.equal(disk.models["custom-0000ffff"]?.model, "x");
});

test("那家一出现，默认就换回盘上选的那家与型号", () => {
  // 换 mtime + 大小，custom-providers.ts 按这两样判文件变了
  fs.writeFileSync(pluginFile, JSON.stringify({ v: 2, providers: [service] }));
  const c = getConfig();
  assert.equal(c.provider, ID);
  assert.equal(c.model, "qwen-next");
  assert.equal(c.thinking, "medium");
  assert.equal(c.permissionMode, "plan", "期间改过的其它设置不丢");
});

test("亲手换过厂商就不再认领（换了再出现也不跳回去）", async () => {
  setConfig({ provider: "kimi" });
  assert.equal(getConfig().provider, "kimi");
  await configWritesSettled();
  assert.equal(JSON.parse(fs.readFileSync(choiceFile, "utf8")).provider, "kimi");
});

test("设置页选的工作空间落盘；选回默认就不记", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ws-"));
  setConfig({ workspace: ws });
  await configWritesSettled();
  assert.equal(JSON.parse(fs.readFileSync(choiceFile, "utf8")).workspace, path.resolve(ws));
  setConfig({ workspace: "" });
  await configWritesSettled();
  assert.equal(JSON.parse(fs.readFileSync(choiceFile, "utf8")).workspace, undefined);
});
