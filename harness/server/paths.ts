// Q8（X47 / N38 / K04，根治 #14）：dimensio 数据位置的唯一解析点。
//
// 以前十几处代码各自按 process.cwd() / 家目录回落解析数据位置（sessions、memory、knowledge、runtime-config、
// quick、projects、默认工作区、全局 GUIDE、.env、bridge 数据根），测试隔离只能在 test-setup.ts 里逐个改道，
// 漏一个就是一类污染：#14（测试往 memory / knowledge 撒了 650 个桶，还把一条测试记忆提交进了库）就是当初漏掉的
// 那两个，另有几个测试收尾时 `delete process.env.MEMORY_DIR`，之后的写入就回落到了生产目录。现在：
//   ① 数据位置一律在这里解析（环境变量覆盖 → 默认值）。server/ 下别的文件不许再出现 process.cwd()
//      （paths.test.ts 扫源码守着）。生产里 cwd 就是 harness/：bridge 以它为 cwd 拉起，独立开发也在这里起。
//   ② 测试进程（node --test 的子进程，或 test-setup.ts 打了标记的进程及其子进程）解析出的数据位置必须在系统临时
//      目录下，否则直接抛错——显式设的环境变量也不认（有人在 shell 里 export 了生产路径再跑测试）。
//   ③ 测试进程不加载 .env（里面是各家 key）、不认临时目录之外的 bridge 数据根（扩展注册表、本机 broker 描述文件）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// node --test 给每个测试文件的子进程设 NODE_TEST_CONTEXT；test-setup.ts 另打 DIMENSIO_TEST_ISOLATION，
// 测试里 spawn 出来的真 harness 继承它，也算测试进程。
export function inTestProcess(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.DIMENSIO_TEST_ISOLATION);
}

function tmpRoots(): string[] {
  const t = path.resolve(os.tmpdir());
  const roots = [t];
  try {
    roots.push(fs.realpathSync.native(t)); // 8.3 短名与长名是同一个目录
  } catch {
    /* 临时目录不存在就只认字面形式 */
  }
  return [...new Set(roots.map(fold))];
}

// 严格在系统临时目录之内（临时目录本身不算）。
export function underTmp(p: string): boolean {
  const abs = fold(path.resolve(p));
  // Q9：包含关系用 path.relative 判（guards 的 containment-startswith），不手写 startsWith(root + sep)
  return tmpRoots().some((t) => {
    const rel = path.relative(t, abs);
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  });
}

function guard(what: string, p: string): string {
  if (inTestProcess() && !underTmp(p)) {
    throw new Error(
      `测试进程解析到了临时目录之外的${what}：${p}。测试不许读写生产数据——用 npm test 跑（test-setup.ts 会把数据位置` +
        `全部改道到临时目录；单跑一个文件用 node --import ./server/test-setup.ts --test server/<名>.test.ts），` +
        `测试里自设过的环境变量收尾时还原成进入时的值，不要 delete。见 server/paths.ts。`,
    );
  }
  return p;
}

function fromEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? path.resolve(v) : undefined;
}

const harnessCwd = (): string => process.cwd();

export function sessionsDir(): string {
  return guard("会话目录", fromEnv("SESSIONS_DIR") ?? path.resolve(harnessCwd(), "sessions"));
}

export function memoryRoot(): string {
  return guard("记忆目录", fromEnv("MEMORY_DIR") ?? path.resolve(harnessCwd(), "memory"));
}

export function knowledgeRoot(): string {
  return guard("项目知识目录", fromEnv("KNOWLEDGE_DIR") ?? path.resolve(harnessCwd(), "knowledge"));
}

// 上次选的厂商 / 模型 / 思考档与权限配置（config.ts）。
export function configFile(): string {
  return guard("运行配置文件", fromEnv("DIMENSIO_CONFIG_FILE") ?? path.resolve(harnessCwd(), "runtime-config.json"));
}

// 自定义模型服务（custom-providers.ts）：providers.json 是地址与备注，同目录的 connector-secrets.* 是加密的 API key。
export function customProvidersDir(): string {
  return guard("自定义模型服务目录", fromEnv("DIMENSIO_CUSTOM_PROVIDERS_DIR") ?? path.resolve(harnessCwd(), "custom-providers"));
}

// 快照对话：当前那只桶的指针，与桶根（quick.ts）。
export function quickFile(): string {
  return guard("快照对话指针", fromEnv("DIMENSIO_QUICK_FILE") ?? path.resolve(harnessCwd(), "quick.json"));
}

export function quickRoot(): string {
  return guard("快照对话桶根", fromEnv("DIMENSIO_QUICK_ROOT") ?? path.join(os.homedir(), ".dimensio", "quick"));
}

// 项目注册表与新建项目的默认父目录（projects.ts）。
export function projectsFile(): string {
  return guard("项目注册表", fromEnv("PROJECTS_FILE") ?? path.resolve(harnessCwd(), "projects.json"));
}

export function projectsRoot(): string {
  return guard("项目根目录", fromEnv("PROJECTS_ROOT") ?? path.join(os.homedir(), "Dimensio Projects"));
}

// 启动时的默认工作区；配置里 `workspace: ""` 就回到它。
export function defaultWorkspace(): string {
  return guard("默认工作区", fromEnv("WORKSPACE_DIR") ?? path.resolve(harnessCwd(), "workspace"));
}

// 机器级 GUIDE（对所有工作区生效，注入 system prompt）。
export function globalGuideFile(): string {
  return guard("全局 GUIDE", fromEnv("DIMENSIO_GLOBAL_GUIDE") ?? path.join(os.homedir(), ".dimensio", "GUIDE.md"));
}

// .env（各家 API key）。测试进程只认显式指到临时目录下的文件，否则一个都不加载。
export function envFile(): string | null {
  const explicit = fromEnv("HARNESS_ENV_FILE");
  if (inTestProcess()) return explicit && underTmp(explicit) ? explicit : null;
  return explicit ?? path.resolve(harnessCwd(), ".env");
}

// bridge 数据根的候选（扩展注册表 extensions/registry.json、本机 broker 描述文件 local-pc-broker.json 放在这里），
// 按优先级：显式环境变量 → （本机 broker 另认 harness/ 自身）→ harness/ 的上级，也就是独立开发时的 bridge 根。
// 测试进程只认临时目录下的。
export function bridgeRootCandidates(opts: { withHarnessDir?: boolean } = {}): string[] {
  // 租户实例（bridge 给注册用户拉的，DIMENSIO_TENANT=1）一个都不认：扩展注册表里是管理员的连接器凭据，
  // 本机 broker 描述文件能驱动真桌面——都不是他的。见 tenant.ts。
  if (process.env.DIMENSIO_TENANT === "1") return [];
  const roots = [
    process.env.BRIDGE_DATA_ROOT,
    process.env.BRIDGE_ROOT,
    opts.withHarnessDir ? harnessCwd() : undefined,
    path.resolve(harnessCwd(), ".."),
  ]
    .filter((v): v is string => Boolean(v?.trim()))
    .map((v) => path.resolve(v));
  return [...new Set(roots)].filter((root) => !inTestProcess() || underTmp(root));
}
