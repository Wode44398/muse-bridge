#!/usr/bin/env node
// Standalone stdio MCP server exposing Google Vertex media generation as native
// tools for desktop Claude Code (image / video / speech / music). Reuses the
// bridge's proven drivers + ADC + Gemini key (from config.json). Each tool
// writes the result to a file and returns its ABSOLUTE PATH so Claude can use
// it as an asset (read it, copy it into a project, embed in HTML, etc.).
//
// Register in <project>/.mcp.json:
//   { "mcpServers": { "vertex-media": { "command": "node",
//       "args": ["C:\\Users\\you\\claude-bridge\\mcp-media.mjs"] } } }
//
// Tool schemas / clamps / driver calls live in modules/vertex/server/mcp/media-tools.mjs (shared
// with the phone bridge's in-process MEDIA_MCP in src/server.mjs). This file is
// just the desktop adapter (write-to-disk + English result text + no events).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installCoreResolver } from './src/modules/core-resolve.mjs';

// 媒体工具住在 Vertex 功能扩展里（modules/vertex），它经 @bridge/core 引核心——先装解析钩子再动态加载。
installCoreResolver();
const { buildMediaTools } = await import('./modules/vertex/server/mcp/media-tools.mjs');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = (() => { try { return JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
const PROJECT = cfg.vertexProject || '225322445252';
const GLOBAL_LOC = cfg.vertexLocation || 'global';
const MEDIA_LOC = cfg.vertexMediaLocation || 'us-central1';
const GEMINI_KEY = cfg.geminiApiKey || '';
const OUTDIR = path.join(ROOT, 'genmedia');
mkdirSync(OUTDIR, { recursive: true });

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
  save: (id, bytes, ext, meta, outputPath) => writeOut(bytes, ext, outputPath, (meta && meta.kind) || 'media'),
  emit: () => {},
  resultText: (kind, info) => {
    if (kind === 'image') return 'Image generated. Absolute path:\n' + info.file;
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
for (const t of buildMediaTools({
  flavor: 'desktop',
  adapter: desktopAdapter,
  loc: { project: PROJECT, globalLoc: GLOBAL_LOC, mediaLoc: MEDIA_LOC, apiKey: GEMINI_KEY },
})) {
  server.tool(t.name, t.description, t.schema, t.handler);
}

await server.connect(new StdioServerTransport());
