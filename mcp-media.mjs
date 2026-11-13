#!/usr/bin/env node
// Standalone stdio MCP server exposing Media Studio generation as native tools for desktop
// Claude Code (image / video / speech / music). Reuses the bridge's Studio services (the host
// admin's providers + encrypted keys in the data root — the same ones the bridge's own Claude uses).
// Each tool writes the result to a file and returns its ABSOLUTE PATH so Claude can use
// it as an asset (read it, copy it into a project, embed in HTML, etc.).
//
// Register in <project>/.mcp.json:
//   { "mcpServers": { "vertex-media": { "command": "node",
//       "args": ["C:\\Users\\you\\claude-bridge\\mcp-media.mjs"] } } }
//
// Tool schemas / clamps live in modules/studio/server/mcp/media-tools.mjs (shared
// with the phone bridge's in-process media MCP). This file is just the desktop adapter
// (write-to-disk + English result text + no events). 2026-11-04 起生成走 Media Studio
// （modules/studio/server/jobs.mjs runDirect）：`model` 收裸 id 或 '<服务>/<模型>'。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installCoreResolver } from './src/modules/core-resolve.mjs';

// 媒体工具住在 Media Studio 功能扩展里（modules/studio），它经 @bridge/core 引核心——先装解析钩子再动态加载。
installCoreResolver();
const { buildMediaTools } = await import('./modules/studio/server/mcp/media-tools.mjs');
const { runDirect } = await import('./modules/studio/server/jobs.mjs');
const { toolDefaults } = await import('./modules/studio/server/mcp/media-phone.mjs');
const { autoImportIfEmpty } = await import('./modules/studio/server/migrate.mjs');
const { imageDims } = await import('./modules/studio/server/adapters/openrouter-image.mjs');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(ROOT, 'genmedia');
mkdirSync(OUTDIR, { recursive: true });

// 主机还没有 Studio 服务（升级后 bridge 还没起过）：照首次启动迁移导一次 Vertex 配置
await autoImportIfEmpty().catch(() => null);

// Write bytes to outputPath (if absolute) or a default genmedia/ file; return abs path.
function writeOut(bytes, ext, outputPath, tag) {
  const dest = (outputPath && path.isAbsolute(outputPath))
    ? outputPath
    : path.join(OUTDIR, Date.now() + '-' + (tag || 'media') + '.' + ext);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return dest;
}

// Desktop adapter: write artifacts to disk (optionally at a user-chosen outputPath),
// English result text, no event emission (no client to push to over stdio).
const desktopAdapter = {
  newId: () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  generate: async (kind, body, { id, outputPath, onProgress }) => {
    const r = await runDirect({ ...body, onProgress });
    const o = r.outputs[0];
    if (!o) throw new Error('no result returned');
    // 图片顺手量一下实际像素报给 Claude（runDirect 不回下发参数，这边只报像素、不判降档）
    const dims = kind === 'image' ? imageDims(o.bytes) : null;
    return { id, file: writeOut(o.bytes, o.ext, outputPath, kind === 'speech' ? 'audio' : kind), model: r.entry.id, ...(dims ? { width: dims[0], height: dims[1] } : {}) };
  },
  emit: () => {},
  resultText: (kind, info) => {
    if (kind === 'image') return 'Image generated' + (info.width ? ' (' + info.width + '×' + info.height + ' px)' : '') + '. Absolute path:\n' + info.file;
    if (kind === 'video') return 'Video generated (' + info.model + ' · ' + info.resolution + '). Absolute path:\n' + info.file;
    if (kind === 'audio') return 'Speech generated. Absolute path:\n' + info.file;
    if (kind === 'music') return 'Music generated. Absolute path:\n' + info.file;
    return 'Generated. Absolute path:\n' + info.file;
  },
  errorText: (kind, e) => {
    const label = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Speech' : kind === 'music' ? 'Music' : 'Media';
    return label + ' generation failed: ' + String(e?.message ?? e);
  },
};

const server = new McpServer({ name: 'vertex-media', version: '1.0.0' });
for (const t of buildMediaTools({ flavor: 'desktop', adapter: desktopAdapter, defaults: toolDefaults('admin') })) {
  server.tool(t.name, t.description, t.schema, t.handler);
}

await server.connect(new StdioServerTransport());
