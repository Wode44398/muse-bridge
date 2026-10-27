// POST to /api/run and parse the streamed SSE response, calling onEvent for
// each decoded event object.
export async function runStream(
  body: { sessionId?: string | null; message: string },
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    onEvent({ e: "error", message: `HTTP ${res.status}`, retriable: false });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");

    let boundary: number;
    while ((boundary = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, boundary);
      buf = buf.slice(boundary + 2);
      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).replace(/^ /, "");
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore keep-alives / partial */
        }
      }
    }
  }
}
