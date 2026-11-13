// 模型档案 P0：借正式服的自定义模型服务跑评测——把 harness/custom-providers 整目录原样复制到临时目录，评测臂经
// DIMENSIO_CUSTOM_PROVIDERS_DIR 指过去。密钥文件（connector-secrets.*，DPAPI 加密）只按字节复制，不解密、不打印。
//
//   node evals/ab/providers-copy.ts --from <正式服 harness/custom-providers> --to <临时目录> [--fix-vllm-thinking custom-xxxx,…]
//
// --fix-vllm-thinking：vLLM 的 Qwen 模板不认顶层 enable_thinking（「关闭」档发了也照样想，旁路请求的额度全花在思考上、正文为空），
// 要放进 chat_template_kwargs。只改副本里这几家服务的档位表（providers.json 的 modelSpecs[].efforts[].value），正式服那份不动。
import fs from "node:fs";
import path from "node:path";

// 副本标记：只有带它的目录（以前复制出来的副本）才允许整个删掉重来
export const COPY_MARKER = ".dimensio-eval-copy";

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// 复制前先删旧副本。--to 填错（与 --from 相同、是它的上级或下级、或是别的有内容的目录）会把正式服的服务目录连同加密密钥
// 一起删掉，所以只删两种：空目录、带副本标记的旧副本；别的一律拒绝。
export function copyProviders(fromRaw: string, toRaw: string): string[] {
  const from = path.resolve(fromRaw);
  const to = path.resolve(toRaw);
  if (!fs.existsSync(path.join(from, "providers.json"))) throw new Error(`${from} 下没有 providers.json，不像自定义服务目录`);
  // Windows 上路径不分大小写
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (inside(norm(to), norm(from)) || inside(norm(from), norm(to))) {
    throw new Error(`--to（${to}）与 --from（${from}）相同或互相包含，拒绝（会删掉正式服的服务目录）`);
  }
  if (fs.existsSync(to)) {
    if (!fs.statSync(to).isDirectory()) throw new Error(`--to（${to}）是个文件，拒绝`);
    const entries = fs.readdirSync(to);
    if (entries.length && !entries.includes(COPY_MARKER)) throw new Error(`--to（${to}）不是空目录、也不是以前复制出来的副本（没有 ${COPY_MARKER}），拒绝删除`);
    fs.rmSync(to, { recursive: true, force: true });
  }
  fs.cpSync(from, to, { recursive: true });
  fs.writeFileSync(path.join(to, COPY_MARKER), `评测用的自定义服务目录副本，复制自 ${from}\n`);
  return fs.readdirSync(to).filter((f) => f !== COPY_MARKER);
}

type Effort = { id?: string; value?: Record<string, unknown> };

// 顶层 enable_thinking 挪进 chat_template_kwargs；已经挪过的不动。返回改了几档。
export function fixVllmThinking(providersJson: string, ids: string[]): number {
  const doc = JSON.parse(fs.readFileSync(providersJson, "utf8")) as { providers?: unknown };
  const list = (Array.isArray(doc.providers) ? doc.providers : Object.values(doc.providers ?? doc)) as { id?: string; modelSpecs?: unknown }[];
  let changed = 0;
  for (const p of list) {
    if (!p || !ids.includes(String(p.id))) continue;
    const specs = (Array.isArray(p.modelSpecs) ? p.modelSpecs : Object.values(p.modelSpecs ?? {})) as { efforts?: Effort[] }[];
    for (const spec of specs) {
      for (const e of spec?.efforts ?? []) {
        const v = e.value;
        if (!v || typeof v !== "object" || !("enable_thinking" in v)) continue;
        const { enable_thinking, ...rest } = v;
        const kwargs = (rest.chat_template_kwargs ?? {}) as Record<string, unknown>;
        e.value = { ...rest, chat_template_kwargs: { ...kwargs, enable_thinking } };
        changed++;
      }
    }
  }
  fs.writeFileSync(providersJson, JSON.stringify(doc, null, 2) + "\n");
  return changed;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = opt("from");
  const to = opt("to");
  if (!from || !to) {
    console.error("用法：node evals/ab/providers-copy.ts --from <harness/custom-providers> --to <临时目录> [--fix-vllm-thinking custom-xxxx,…]");
    process.exit(2);
  }
  const files = copyProviders(path.resolve(from), path.resolve(to));
  console.log(`已复制 ${files.length} 个文件到 ${path.resolve(to)}（密钥文件原样复制，未解密）`);
  const fix = opt("fix-vllm-thinking");
  if (fix) console.log(`chat_template_kwargs 修正：改了 ${fixVllmThinking(path.join(path.resolve(to), "providers.json"), fix.split(","))} 档`);
  console.log(`评测时加：--providers-dir ${path.resolve(to)}`);
}
