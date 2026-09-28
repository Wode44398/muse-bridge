// M5（K03、#13）：会话资源账本。
//
// 以前 bash 后台 job、Preview dev server、共享浏览器的占用各有一张登记表、各有回收函数，停止 / 删除 / 轮结束 / 关停
// 这几个出口各自记得调哪几个——删除会话漏收过 job 和 dev server（#13：删掉的对话照样跑满 2 小时，UI 上也停不掉）。
// 现在谁起资源谁登记：registerResource(owner, kind, id, dispose)，拿回一个 release（资源自己先结束了、或被单独停了，
// 就注销这一条）；出口只说 disposeOwner(owner, reason, kinds)：按登记的逆序拆，返回每类真正拆掉了几个（停止会话的
// 回执照旧如实报告）。拆的时候先注销再调 dispose——dispose 里再去注销自己是空操作；某一条拆失败只记一行，不挡后面的。
// PTY 终端按工作区归属，不进会话账本。

export type ResourceKind = "job" | "service" | "browser";
export const RESOURCE_KINDS: readonly ResourceKind[] = ["job", "service", "browser"];
export type ResourceCounts = Record<ResourceKind, number>;

interface Entry {
  kind: ResourceKind;
  id: string;
  // 返回 true = 真拆掉了一个还活着的（计数用）
  dispose: (reason: string) => boolean;
}

const books = new Map<string, Entry[]>(); // owner（会话 id；"" = 不属于任何会话）→ 按登记顺序

function remove(owner: string, entry: Entry): void {
  const book = books.get(owner);
  if (!book) return;
  const at = book.indexOf(entry);
  if (at >= 0) book.splice(at, 1);
  if (!book.length) books.delete(owner);
}

export function registerResource(owner: string, kind: ResourceKind, id: string, dispose: (reason: string) => boolean): () => void {
  const entry: Entry = { kind, id, dispose };
  const book = books.get(owner);
  if (book) book.push(entry);
  else books.set(owner, [entry]);
  return () => remove(owner, entry);
}

export function disposeOwner(owner: string, reason: string, kinds: readonly ResourceKind[] = RESOURCE_KINDS): ResourceCounts {
  const counts: ResourceCounts = { job: 0, service: 0, browser: 0 };
  const book = books.get(owner);
  if (!book) return counts;
  for (const entry of [...book].reverse()) {
    if (!kinds.includes(entry.kind)) continue;
    remove(owner, entry);
    try {
      if (entry.dispose(reason)) counts[entry.kind]++;
    } catch (error) {
      console.error(`[resources] ${reason}: ${entry.kind} ${entry.id} 没收掉：${(error as Error).message}`);
    }
  }
  return counts;
}

export function disposeAll(reason: string, kinds: readonly ResourceKind[] = RESOURCE_KINDS): ResourceCounts {
  const total: ResourceCounts = { job: 0, service: 0, browser: 0 };
  for (const owner of [...books.keys()]) {
    const counts = disposeOwner(owner, reason, kinds);
    for (const kind of RESOURCE_KINDS) total[kind] += counts[kind];
  }
  return total;
}

export function resourcesOf(owner: string): Array<{ kind: ResourceKind; id: string }> {
  return (books.get(owner) ?? []).map(({ kind, id }) => ({ kind, id }));
}

export function resourceOwners(): string[] {
  return [...books.keys()];
}
