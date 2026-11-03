// Minimal line diff (longest common subsequence). Used to count +/- lines
// for a proposal and to highlight lines after a change is applied.
// Monaco's diff editor does the visual diff during review.

export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: b[j], newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'removed', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'added', line: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'removed', line: a[i++] });
  while (j < m) {
    ops.push({ type: 'added', line: b[j], newLine: j + 1 });
    j++;
  }
  return ops;
}

export function diffStats(before, after) {
  const ops = diffLines(before, after);
  return {
    added: ops.filter((o) => o.type === 'added').length,
    removed: ops.filter((o) => o.type === 'removed').length,
    // 1-based line numbers in the new text that were added or changed
    changedLines: ops.filter((o) => o.type === 'added').map((o) => o.newLine),
  };
}
