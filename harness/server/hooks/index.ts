// 用户 hooks（Claude Code 同格式）：配置读取、信任、执行与 agent 运行里的挂点。实现在同目录各文件。
export { HOOK_EVENTS, type HookEvent, loadHookConfig, matcherHits } from "./config.ts";
export { SessionHooks } from "./session.ts";
export { projectHooksTrusted, trustProjectHooks } from "./trust.ts";
export {
  appendPromptContext,
  applyHookPermission,
  HOOK_KIND,
  HOOK_RULE,
  HOOK_TRUST_RULE,
  hookDeniedText,
  hookHeader,
  MAX_STOP_HOOK_BLOCKS,
  postToolHook,
  preCompactHook,
  preToolHook,
  runStartHooks,
  stopHook,
  userPromptHook,
  type PreToolHook,
} from "./points.ts";
