// M7（D1）：落盘记录的版本与迁移——会话记录（及检查点里的记录副本）先用上，别的带 v 的文件要提版本时照此接入。
//
// 以前会话记录 `v !== 1` 一律当读不出来：换一次格式，全部旧会话从列表里消失；M6 之后更糟，会被当成坏文件隔离掉。
// 规矩：
//   - 读的时候按迁移链逐级升到本代码的版本，写永远写本版本。
//   - 迁移链只追加：migrations[n] 把 v=n 的记录升到 v=n+1，纯函数，只增字段并给默认值；已发布的步骤永不修改。
//     每加一步，record-version.test.ts 里配一条「旧版本夹具 → 当前形状」的用例。
//   - 比本代码新的记录（部署回滚到旧版本时会遇到）不是坏文件：不隔离、不恢复、不写回（整份覆盖写会抹掉新版本的
//     字段），只读展示；恢复运行、回滚一律拒绝。
//   - 先让这套框架上线，再提记录的版本：否则还没有它的旧部署读到新记录，会按坏文件处理。

export type RawRecord = { v: number; [key: string]: unknown };
export type RecordMigration = (rec: RawRecord) => RawRecord;

export type VersionedRead =
  | { kind: "ok"; rec: RawRecord; migratedFrom?: number }
  | { kind: "corrupt"; reason: string }
  | { kind: "unsupported-version"; version: number; raw: Record<string, unknown> };

// 纯函数：只看版本号与迁移链，不看业务字段（业务校验由调用方在 ok 之后做）。
export function readVersioned(
  raw: unknown,
  current: number,
  migrations: Readonly<Record<number, RecordMigration>>,
): VersionedRead {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "corrupt", reason: "not an object" };
  const obj = raw as Record<string, unknown>;
  const v = obj.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { kind: "corrupt", reason: "missing or invalid version" };
  if (v > current) return { kind: "unsupported-version", version: v, raw: obj };
  let rec = obj as RawRecord;
  while (rec.v < current) {
    const step = migrations[rec.v];
    if (!step) return { kind: "corrupt", reason: `no migration from version ${rec.v}` };
    let next: RawRecord;
    try {
      next = step(rec);
    } catch (e) {
      return { kind: "corrupt", reason: `migration from version ${rec.v} failed: ${(e as Error).message}` };
    }
    if (next?.v !== rec.v + 1) return { kind: "corrupt", reason: `migration from version ${rec.v} did not produce version ${rec.v + 1}` };
    rec = next;
  }
  return v < current ? { kind: "ok", rec, migratedFrom: v } : { kind: "ok", rec };
}
