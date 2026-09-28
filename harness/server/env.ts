import { existsSync } from "node:fs";
import { envFile } from "./paths.ts";

// Load .env if present. Imported first (before config.ts reads process.env) so
// a missing .env is a no-op rather than a hard crash. 位置见 paths.ts：测试进程只认
// 显式指到临时目录下的文件，否则一个都不加载（.env 里是各家 key）。
const envPath = envFile();
if (envPath && existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* malformed .env — ignore, fall back to real env */
  }
}
