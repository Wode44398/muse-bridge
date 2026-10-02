// dimensio 英文界面字典：本目录下每个分区文件 export default { "中文原文": "English", … }，这里合并成一份。
// 只在界面语言为 English 时动态加载（独立运行由 lib/i18n-boot.ts，嵌进 bridge 由 bridge 的 lib/i18n.js）。
// 同一中文键跨文件必须同一译法；冲突、漏译、占位符不一致由 bridge 仓库的 web/scripts/i18n-check.mjs 查。
type Val = string | { one?: string; other?: string };

const mods = import.meta.glob<Record<string, Val>>(["./*.ts", "!./index.ts"], { eager: true, import: "default" });

const dict: Record<string, Val> = Object.create(null);
for (const k of Object.keys(mods).sort()) Object.assign(dict, mods[k]);

export default dict;
