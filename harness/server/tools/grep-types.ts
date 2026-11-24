// Grep 的 type 过滤：语言名 → 扩展名（取 ripgrep --type-list 里常用的那部分，名字照它的写法）。
const TYPES: Record<string, string[]> = {
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl"],
  cs: ["cs", "csx"],
  css: ["css", "scss", "sass", "less"],
  dart: ["dart"],
  go: ["go"],
  html: ["html", "htm", "xhtml"],
  java: ["java"],
  js: ["js", "jsx", "mjs", "cjs", "vue"],
  json: ["json", "jsonc", "json5"],
  kotlin: ["kt", "kts"],
  lua: ["lua"],
  md: ["md", "markdown", "mdx"],
  php: ["php", "phtml"],
  ps: ["ps1", "psm1", "psd1"],
  py: ["py", "pyi", "pyw"],
  rb: ["rb", "rake", "gemspec"],
  rust: ["rs"],
  scala: ["scala", "sc"],
  sh: ["sh", "bash", "zsh", "ksh"],
  sql: ["sql"],
  svelte: ["svelte"],
  swift: ["swift"],
  toml: ["toml"],
  ts: ["ts", "tsx", "mts", "cts"],
  vue: ["vue"],
  xml: ["xml", "xsd", "xsl", "svg"],
  yaml: ["yaml", "yml"],
};
// 常见的别称
const ALIAS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  ruby: "rb",
  rs: "rust",
  golang: "go",
  markdown: "md",
  shell: "sh",
  bash: "sh",
  yml: "yaml",
  "c++": "cpp",
  csharp: "cs",
  kt: "kotlin",
  powershell: "ps",
  jsx: "js",
  tsx: "ts",
};

export const TYPE_NAMES: string[] = Object.keys(TYPES);

/** 语言名的过滤函数（按相对路径的扩展名）；不认识的名字返回 undefined。 */
export function typeFilter(name: string): ((rel: string) => boolean) | undefined {
  const key = name.trim().toLowerCase();
  const exts = TYPES[key] ?? TYPES[ALIAS[key] ?? ""];
  if (!exts) return undefined;
  const set = new Set(exts);
  return (rel) => {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 && set.has(base.slice(dot + 1).toLowerCase());
  };
}
