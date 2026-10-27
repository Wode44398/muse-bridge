// C5 的 A/B 夹具：照一份真注册表搭一个「形状一样、跑不出真数据」的技能目录。
//
//   node evals/ab/skills-fixture.ts --from <真 registry.json> --out <夹具目录>
//
// 只取勾给 dimensio 的技能条目，而且只抄这几个字段：id / type / name / description / enabled / agents / dir / entry / pkg
// ——连接器（凭据）与其余任何字段一概不碰，也不打印注册表里的任何值。每个技能目录只拷 .md 文件（SKILL.md 与它引用的说明），
// 脚本（.py / .mjs / .js / .cjs / .sh / .ps1 / .bat）一律换成同名的桩：打印一段固定的假结果、说明这是评测环境——模型选错
// 技能也不会拿真凭据去取数；其余文件（配置、二进制）不拷。
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const from = opt("from");
const out = opt("out");
if (!from || !out) {
  console.error("用法：node evals/ab/skills-fixture.ts --from <registry.json> --out <夹具目录>");
  process.exit(2);
}
if (fs.existsSync(out)) {
  console.error(`${out} 已存在——换个目录，或者先删掉它`);
  process.exit(2);
}

interface Item {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  agents?: { dimensio?: unknown };
  dir?: unknown;
  entry?: unknown;
  pkg?: unknown;
}

let text = fs.readFileSync(from, "utf8");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const items: Item[] = (JSON.parse(text) as { items?: Item[] }).items ?? [];
const srcRoot = path.dirname(path.resolve(from));
const extRoot = path.join(out, "extensions");

const STUB_PY = `import json, sys
print(json.dumps({"ok": True, "stub": True, "note": "evaluation fixture: no data access here; treat this as the query result", "args": sys.argv[1:], "data": [{"metric": "value", "value": 12.34}]}, ensure_ascii=False))
`;
const STUB_JS = `console.log(JSON.stringify({ ok: true, stub: true, note: "evaluation fixture: no data access here; treat this as the query result", args: process.argv.slice(2), data: [{ metric: "value", value: 12.34 }] }));
`;
const STUB_SH = `echo '{"ok": true, "stub": true, "note": "evaluation fixture: no data access here", "data": [{"metric": "value", "value": 12.34}]}'
`;
const stubFor = (file: string): string | null => {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".py") return STUB_PY;
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") return STUB_JS;
  if (ext === ".sh" || ext === ".ps1" || ext === ".bat" || ext === ".cmd") return STUB_SH;
  return null;
};

let copied = 0;
let stubbed = 0;
function mirror(src: string, dst: string): void {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      mirror(s, d);
      continue;
    }
    if (!ent.isFile()) continue;
    const stub = stubFor(ent.name);
    if (stub !== null) {
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(d, stub);
      stubbed++;
    } else if (ent.name.toLowerCase().endsWith(".md")) {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(s, d);
      copied++;
    }
  }
}

const kept: Record<string, unknown>[] = [];
for (const it of items) {
  if (it.type !== "skill" || !it.enabled || !it.agents?.dimensio || typeof it.dir !== "string") continue;
  const src = path.resolve(srcRoot, it.dir);
  if (!src.startsWith(srcRoot + path.sep) || !fs.existsSync(src)) continue;
  mirror(src, path.join(extRoot, it.dir));
  kept.push({
    id: String(it.id ?? ""),
    type: "skill",
    name: String(it.name ?? ""),
    description: String(it.description ?? ""),
    enabled: true,
    agents: { dimensio: true },
    dir: it.dir,
    entry: typeof it.entry === "string" ? it.entry : "SKILL.md",
    ...(typeof it.pkg === "string" && it.pkg ? { pkg: it.pkg } : {}),
  });
}
fs.mkdirSync(extRoot, { recursive: true });
fs.writeFileSync(path.join(extRoot, "registry.json"), JSON.stringify({ items: kept }, null, 2));
console.log(`夹具：${kept.length} 个技能，拷了 ${copied} 个 .md，换了 ${stubbed} 个脚本桩 → ${path.join(extRoot, "registry.json")}`);
