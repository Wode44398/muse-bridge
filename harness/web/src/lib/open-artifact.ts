// 宿主（bridge 分页）给的「打开产物」回调——手机上它把文件交给 bridge 的查看器（能分享 / 另存）。
// App 挂载时登记；Feed 之外的地方（诊断包导出）也用得上。没有宿主（独立 8799 / 预览）就是 null。
import type { ArtifactItem } from "./timeline-types.ts";

type ArtifactHost = (artifact: ArtifactItem, sessionId: string) => void;
let host: ArtifactHost | null = null;

export function setArtifactHost(fn: ArtifactHost | null): void {
  host = fn;
}

export function artifactHost(): ArtifactHost | null {
  return host;
}
