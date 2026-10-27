// Tiny, safe markdown-ish renderer: escapes HTML first, then handles fenced
// code blocks, inline code, bold, and headings. No dependencies, no raw HTML
// from the model ever reaches the DOM unescaped.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|<br>)\s*(#{1,6})\s+([^<]+)/g, '$1<span class="h">$3</span>')
    .replace(/\n/g, "<br>");
}

export function renderMarkdown(src: string): string {
  const parts = src.split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i];
      const nl = code.indexOf("\n");
      if (nl !== -1) {
        const first = code.slice(0, nl).trim();
        if (/^[a-z0-9+#.-]*$/i.test(first)) code = code.slice(nl + 1);
      }
      html += `<pre class="code"><code>${esc(code)}</code></pre>`;
    } else if (parts[i]) {
      html += inline(esc(parts[i]));
    }
  }
  return html;
}
