// Antigravity 项目表：复用核心路径授权守卫，每个项目对应主机上的一个工作目录（即 ACP 会话 cwd）。

import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { authorizeProjectPath, projectLocations, fold } from '@bridge/core/project-paths.mjs';

export { authorizeProjectPath, projectLocations };

const MAX_PROJECTS = 200;

function readStore(file) {
  const data = readJson(file, { projects: [] });
  return { projects: Array.isArray(data.projects) ? data.projects : [] };
}

const dirLabel = (p) => path.basename(path.resolve(p || '')) || String(p || '');

function cleanName(name, dir) {
  const fallback = dirLabel(dir);
  return String(name || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || fallback;
}

export function listProjects(file) {
  if (!file) return [];
  return readStore(file).projects
    .filter((p) => p && typeof p.id === 'string' && typeof p.path === 'string')
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
    .map((p) => ({ ...p, name: dirLabel(p.path) }));
}

export function getProject(file, id) {
  if (!file || !id) return null;
  return listProjects(file).find((p) => p.id === String(id)) || null;
}

export function findProjectByPath(file, targetPath) {
  if (!file || !targetPath) return null;
  const target = fold(path.resolve(targetPath));
  return listProjects(file).find((p) => fold(path.resolve(p.path || '')) === target) || null;
}

export function createProject(file, ctx, input = {}) {
  const dir = authorizeProjectPath(ctx, input.path);
  const store = readStore(file);
  const same = store.projects.find((p) => fold(path.resolve(p.path || '')) === fold(dir));
  if (same) {
    same.updated = Date.now();
    writeJson(file, store, 2);
    return { ...same, name: dirLabel(same.path) };
  }
  if (store.projects.length >= MAX_PROJECTS) {
    throw Object.assign(new Error('项目数量已达上限'), { status: 400 });
  }
  const now = Date.now();
  const project = {
    id: crypto.randomUUID(),
    name: cleanName(input.name, dir),
    path: dir,
    created: now,
    updated: now,
  };
  store.projects.push(project);
  writeJson(file, store, 2);
  return { ...project, name: dirLabel(project.path) };
}
