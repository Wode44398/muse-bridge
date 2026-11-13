// PullRequest：这个会话绑定的 GitHub 拉取请求。对标 bridge 里 Claude 的 mcp__pr__get_status / bind_pr / unbind_pr /
// sync_with_base_branch（src/mcp/pr-tools.mjs），合成一个工具省前缀：action = status / bind / unbind / sync_base。
// 数据、核对、git 操作全在 bridge（pr-bridge.ts）。开自动修复 / 自动合并不给 agent：那是长期授权，只由用户在 PR 卡上开。
// 只在 bridge 拉起的主机实例上出现（pr-bridge.prChannel）。
import type { PermissionView, Tool } from "./types.ts";
import { fail, ok } from "./types.ts";
import { branchPrefix, prAvailable, prCall } from "../pr-bridge.ts";

const ACTIONS = ["status", "bind", "unbind", "sync_base"] as const;
type Action = (typeof ACTIONS)[number];
const actionOf = (args: Record<string, unknown>): Action => {
  const a = String(args.action ?? "status");
  return (ACTIONS as readonly string[]).includes(a) ? (a as Action) : "status";
};

export const pullRequestTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  enabled: prAvailable,
  // 查状态是只读；绑定 / 移出只改 bridge 的台账；合并基线会改工作区（跟权限档走）
  permissionView: (args): PermissionView | null => (actionOf(args) === "sync_base" ? null : { effect: "read" }),
  def: {
    name: "PullRequest",
    description:
      "The GitHub pull request bound to this session (bridge tracks it with this machine's gh login). " +
      "status (default): number, state, branches, CI check counts and failing check names, review decision, mergeability, whether Auto-fix is on, and the branch prefix for new PR branches — use it instead of polling `gh pr checks`. " +
      "bind {url}: track an existing PR of this workspace's repository (one created by `gh pr create` and reported in a <pr-created> tag is bound already). unbind {url}: stop tracking it. " +
      "sync_base {base?, abort?}: fetch the base branch and merge it into the current branch on the host — pushes nothing; result merged / up_to_date / conflicts (merge left in progress with the files listed: resolve, git add, git commit --no-edit, or call again with abort:true) / refused / failed.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        url: { type: "string", description: "Pull request URL (bind / unbind)." },
        base: { type: "string", description: "sync_base: base branch; defaults to the PR's base, else the repository default branch." },
        abort: { type: "boolean", description: "sync_base: abort a merge it left in progress." },
      },
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const action = actionOf(args);
    const label = `pull request ${action.replace("_", " ")}`;
    const sid = ctx.ownerId;
    if (!sid) return fail(label, "PullRequest works only in the main session (not inside a sub-agent or workflow).");
    const cwd = ctx.sandbox.root;
    const url = typeof args.url === "string" ? args.url.trim() : "";
    try {
      switch (action) {
        case "status": {
          const j = await prCall("status", sid, cwd, {}, ctx.signal ? { signal: ctx.signal } : {});
          const payload = { ...(j.result ?? {}), branchPrefix: `${branchPrefix()}/` };
          // PR 标题、检查名是别人写的：按外部内容算
          return { ok: true, summary: label, content: [{ t: "text", text: JSON.stringify(payload, null, 1) }], externalContent: true };
        }
        case "bind":
        case "unbind": {
          if (!url) return fail(label, "Pass url: the pull request URL, e.g. https://github.com/owner/repo/pull/123");
          const j = await prCall(action, sid, cwd, { url, fromTool: true }, ctx.signal ? { signal: ctx.signal } : {});
          const r = (j.result ?? {}) as { outcome?: string; ok?: boolean };
          if (action === "bind") return ok(label, r.outcome === "exists" ? "Already bound to this session." : `Bound ${url} to this session; its checks and reviews now show on the PR card.`);
          return ok(label, r.ok ? `Removed ${url} from this session; bridge no longer watches it. bind restores it.` : "That pull request is not bound to this session (or was already removed).");
        }
        case "sync_base": {
          const j = await prCall("syncBase", sid, cwd, { base: typeof args.base === "string" ? args.base : "", abort: args.abort === true, fromTool: true }, { timeoutMs: 180_000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return ok(label, JSON.stringify(j.result ?? {}, null, 1));
        }
      }
    } catch (e) {
      return fail(label, (e as Error).message);
    }
  },
};
