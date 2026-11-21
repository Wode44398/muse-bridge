import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgyPath, foldAgyPath, isSameOrSubPath, cleanTitlePaths,
} from './paths.mjs';

test('normalizeAgyPath：解码前导斜杠盘符、file URI、百分号编码与中文路径', () => {
  assert.equal(
    normalizeAgyPath('/C:/Users/dev/AppData/Local/Temp/agy-acp-probe/sample.txt', 'win32'),
    'C:\\Users\\dev\\AppData\\Local\\Temp\\agy-acp-probe\\sample.txt',
  );
  assert.equal(
    normalizeAgyPath('/d%3A/Projects/demo%20app/', 'win32'),
    'D:\\Projects\\demo app',
  );
  assert.equal(
    normalizeAgyPath('file:///c:/Users/dev/Desktop/%E7%AC%94%E8%AE%B0', 'win32'),
    'C:\\Users\\dev\\Desktop\\笔记',
  );
  assert.equal(
    normalizeAgyPath('/c:/', 'win32'),
    'C:\\',
  );
  // 含非编码字面量 % 的文件名不会抛 URIError
  assert.equal(
    normalizeAgyPath('/D:/reports/100%_coverage%20ok.md', 'win32'),
    'D:\\reports\\100%_coverage ok.md',
  );
  assert.equal(
    normalizeAgyPath('file:///home/dev/my%20project/', 'linux'),
    '/home/dev/my project',
  );
});

test('foldAgyPath 与 isSameOrSubPath：跨编码写法判等且不误放行同前缀邻居目录', () => {
  assert.equal(
    foldAgyPath('/d%3A/Projects/demo%20app/', 'win32'),
    foldAgyPath('D:\\Projects\\demo app', 'win32'),
  );
  assert.equal(
    isSameOrSubPath('/d%3A/Projects/demo%20app/design/a.md', 'D:\\Projects\\demo app', 'win32'),
    true,
  );
  assert.equal(
    isSameOrSubPath('D:\\Projects\\demo app2\\a.md', 'D:\\Projects\\demo app', 'win32'),
    false,
  );
});

test('cleanTitlePaths：清理工具标题里的前导斜杠盘符', () => {
  assert.equal(
    cleanTitlePaths('File /C:/Users/dev/cb-agy/sample.txt', 'win32'),
    'File C:\\Users\\dev\\cb-agy\\sample.txt',
  );
});
