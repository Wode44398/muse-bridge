// 把一份干净的报告（schema.mjs 的 cleanReport 产物）排成 GitHub Issue 的标题与正文。
// 服务端拿它给用户预览，Worker 拿它真正提交——同一份代码，用户看到的就是会发出去的。

const KIND_LABEL = { bug: 'Bug', crash: 'Crash', update_failed: 'Update failed', idea: 'Idea', security: 'Security', docs: 'Docs' };
const SOURCE_LABEL = { web: 'reported from the web UI', muse: 'reported through Muse', auto: 'sent automatically (the user opted in)' };

// 用户写的文字原样放进引用块；先把会被 GitHub 当成 @提及 / #引用 / HTML 的写法打断
function quote(text) {
  return String(text || '')
    .replace(/@(?=[A-Za-z0-9-])/g, '@​')
    .replace(/<(?=[A-Za-z/!])/g, '&lt;')
    .split('\n').map((l) => '> ' + l).join('\n');
}
const code = (lines) => '```\n' + lines.join('\n').replace(/```/g, "'''") + '\n```';

export function fpMarker(fp) { return fp ? `<!-- muse-fp:${fp} -->` : ''; }
export function readFpMarker(body) { const m = String(body || '').match(/<!-- muse-fp:([0-9a-f]{12}) -->/); return m ? m[1] : ''; }

export function issueTitle(r) {
  return `[${KIND_LABEL[r.kind] || 'Report'}] ${r.title}`.slice(0, 140);
}

export function issueBody(r) {
  const out = [];
  out.push(`_${SOURCE_LABEL[r.source] || 'reported'} · Muse Bridge ${r.env?.version || '(unknown version)'}_`);
  out.push('');
  if (r.description) {
    out.push('### What happened');
    out.push(quote(r.description));
    out.push('');
  }
  if (r.errors?.length) {
    out.push('### Errors');
    for (const e of r.errors) {
      out.push(`**${e.type}** (${e.where}${e.count > 1 ? `, ${e.count}×` : ''}${e.fp ? `, \`${e.fp}\`` : ''})`);
      out.push(code([e.message, ...e.frames.map((f) => '    at ' + f)]));
    }
    out.push('');
  }
  if (r.logs?.length) {
    out.push('### Log excerpt');
    out.push(code(r.logs));
    out.push('');
  }
  if (r.trail?.length) {
    out.push('<details><summary>Steps before the problem</summary>');
    out.push('');
    out.push(r.trail.map((t, i) => `${i + 1}. ${t.replace(/[<>]/g, '')}`).join('\n'));
    out.push('');
    out.push('</details>');
    out.push('');
  }
  const env = r.env || {};
  const rows = [
    ['Version', env.version], ['Agents', env.agents?.join(', ')], ['Users', env.users], ['Address', env.tunnel === 'named' ? 'own domain' : env.tunnel === 'quick' ? 'temporary (trycloudflare)' : ''],
    ['Auto-update', env.autoUpdate === undefined ? '' : env.autoUpdate ? 'on' : 'off'], ['Node', env.node], ['OS', [env.os, env.arch].filter(Boolean).join(' ')],
    ['Uptime', env.uptimeMin ? `${env.uptimeMin} min` : ''], ['Browser', env.browser], ['Page', env.page], ['UI language', env.uiLang],
    ['Services', Object.entries(r.services || {}).map(([k, v]) => `${k}=${v}`).join(' ')],
    ['Sites', (r.sites || []).map((s) => `${s.host}=${s.state}`).join(' ')],
  ].filter(([, v]) => v);
  if (rows.length) {
    out.push('<details><summary>Environment</summary>');
    out.push('');
    out.push('| | |\n|---|---|');
    for (const [k, v] of rows) out.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);
    out.push('');
    out.push('</details>');
    out.push('');
  }
  out.push(`<sub>Report id \`${r.install.slice(0, 8)}\`${r.fp ? ` · fingerprint \`${r.fp}\`` : ''} · collected by Muse Bridge's built-in reporter (no chats, files, keys or addresses are included).</sub>`);
  if (r.fp) out.push(fpMarker(r.fp));
  return out.join('\n');
}

/** 「+1」评论：同一个指纹别人也遇到了，只记版本和环境 */
export function plusOneBody(r) {
  const env = r.env || {};
  const bits = [env.version && `version ${env.version}`, env.agents?.length && `agents ${env.agents.join('+')}`, r.source && SOURCE_LABEL[r.source]].filter(Boolean);
  const out = [`+1 — seen on another install (${bits.join(', ')}).`];
  if (r.description) { out.push(''); out.push(quote(r.description)); }
  return out.join('\n');
}

export function issueLabels(r) {
  const main = r.kind === 'idea' ? 'enhancement' : r.kind === 'docs' ? 'documentation' : 'bug';
  return ['from-muse', main].concat(r.kind === 'update_failed' ? ['update'] : []);
}
