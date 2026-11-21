// 行级 LCS diff：供编辑类工具卡展开查看增删上下文，超出规模阈值时降级逐段对比以保护渲染帧率。

export function computeDiffLines(oldText = '', newText = '', maxLines = 360) {
  const oldArr = oldText === '' ? [] : String(oldText).replace(/\r\n/g, '\n').split('\n');
  const newArr = newText === '' ? [] : String(newText).replace(/\r\n/g, '\n').split('\n');
  if (oldArr.length && oldArr[oldArr.length - 1] === '' && newArr.length && newArr[newArr.length - 1] === '') {
    oldArr.pop();
    newArr.pop();
  }

  const m = oldArr.length;
  const n = newArr.length;
  const rawOps = [];

  if (m * n <= 90_000) {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = oldArr[i] === newArr[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldArr[i] === newArr[j]) {
        rawOps.push({ type: 'ctx', oldNo: i + 1, newNo: j + 1, text: oldArr[i] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rawOps.push({ type: 'del', oldNo: i + 1, newNo: null, text: oldArr[i] });
        i++;
      } else {
        rawOps.push({ type: 'add', oldNo: null, newNo: j + 1, text: newArr[j] });
        j++;
      }
    }
    while (i < m) rawOps.push({ type: 'del', oldNo: i + 1, newNo: null, text: oldArr[i++] });
    while (j < n) rawOps.push({ type: 'add', oldNo: null, newNo: j + 1, text: newArr[j++] });
  } else {
    // 超大文本跳过二维 DP，先剥公共前后缀再列出变更区
    let pre = 0;
    while (pre < m && pre < n && oldArr[pre] === newArr[pre]) {
      rawOps.push({ type: 'ctx', oldNo: pre + 1, newNo: pre + 1, text: oldArr[pre] });
      pre++;
    }
    let suf = 0;
    while (suf < (m - pre) && suf < (n - pre) && oldArr[m - 1 - suf] === newArr[n - 1 - suf]) {
      suf++;
    }
    for (let i = pre; i < m - suf; i++) rawOps.push({ type: 'del', oldNo: i + 1, newNo: null, text: oldArr[i] });
    for (let j = pre; j < n - suf; j++) rawOps.push({ type: 'add', oldNo: null, newNo: j + 1, text: newArr[j] });
    for (let k = 0; k < suf; k++) {
      rawOps.push({
        type: 'ctx',
        oldNo: m - suf + k + 1,
        newNo: n - suf + k + 1,
        text: oldArr[m - suf + k],
      });
    }
  }

  let added = 0;
  let removed = 0;
  for (const op of rawOps) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }

  const truncated = rawOps.length > maxLines;
  return {
    lines: truncated ? rawOps.slice(0, maxLines) : rawOps,
    added,
    removed,
    truncated,
    totalLines: rawOps.length,
  };
}
