// 表格解析 Worker：SheetJS 读 2 万行要几百毫秒到几秒（手机），放在主线程会把转圈和手势一起卡住。
// 收 { id, buf, ext }，回 { id, book } 或 { id, error, code }。只用一次，用完由主线程 terminate。
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import { parseBook } from './sheet.js';

self.onmessage = (e) => {
  const { id, buf, ext } = e.data || {};
  try {
    const book = parseBook(XLSX, { unzipSync, strFromU8 }, buf, ext);
    self.postMessage({ id, book });
  } catch (err) {
    const msg = String(err?.message || err);
    self.postMessage({ id, error: msg, code: /password|encrypt/i.test(msg) ? 'password' : '' });
  }
};
