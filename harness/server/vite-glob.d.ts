// 服务端测试会连带引到 dimensio 前端的 i18n 字典（web/src/i18n/en/index.ts），那里用了 Vite 的 import.meta.glob。
// 服务端的类型检查没有 Vite 的类型，这里补一个最小声明，让 tsc 认得它。
interface ImportMeta {
  glob<T = unknown>(patterns: string | string[], options?: Record<string, unknown>): Record<string, T>;
}
