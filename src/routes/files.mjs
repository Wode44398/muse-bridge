// Workspace file API facade. Implementation is split by responsibility:
// core mutations/listing, previews, video streaming, and derived content.

import {
  handleCopy,
  handleDelete,
  handleList,
  handleMkdir,
  handleMove,
  handleRename,
  handleSaveFile,
  handleToUpload,
  handleUpload,
} from './file-core.mjs';
import { handleFile, handleOfficePdf } from './file-preview.mjs';
import { handleStream } from './file-video.mjs';
import { handleExtract, handleMdLinks, handleMdNames, handleRelPaths } from './file-derived.mjs';

export {
  moveWorkspaceFile,
  readWorkspaceFile,
  searchWorkspace,
  writeWorkspaceFile,
} from './file-core.mjs';
export { extractArchive, isArchiveName } from './file-derived.mjs';

export function registerFileRoutes(router, { identify }) {
  router.on('GET', '/api/files', (req, res, url) => handleList(req, res, url, identify));
  router.on('GET', '/api/file', (req, res, url) => handleFile(req, res, url, identify));
  router.on('POST', '/api/files/upload', (req, res, url) => handleUpload(req, res, url, identify));
  router.on('POST', '/api/files/mkdir', (req, res) => handleMkdir(req, res, identify));
  router.on('POST', '/api/files/delete', (req, res) => handleDelete(req, res, identify));
  router.on('POST', '/api/files/rename', (req, res) => handleRename(req, res, identify));
  router.on('POST', '/api/files/move', (req, res) => handleMove(req, res, identify));
  router.on('POST', '/api/files/copy', (req, res) => handleCopy(req, res, identify));
  router.on('POST', '/api/file/save', (req, res) => handleSaveFile(req, res, identify));
  router.on('GET', '/api/file/mdlinks', (req, res, url) => handleMdLinks(req, res, url, identify));
  router.on('GET', '/api/file/mdnames', (req, res, url) => handleMdNames(req, res, url, identify));
  router.on('GET', '/api/file/office-pdf', (req, res, url) => handleOfficePdf(req, res, url, identify));
  router.on('GET', '/api/file/stream', (req, res, url) => handleStream(req, res, url, identify));
  router.on('POST', '/api/files/to-upload', (req, res) => handleToUpload(req, res, identify));
  router.on('POST', '/api/files/extract', (req, res) => handleExtract(req, res, identify));
  router.on('POST', '/api/files/relpaths', (req, res) => handleRelPaths(req, res, identify));
}
