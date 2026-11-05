// The error type and message, and the last traceback frame inside the
// project (same rules as parse_traceback in the desktop runtime).

const FRAME = /^\s*File "(.+)", line (\d+)(?:, in (.+))?$/;
const EXC = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)|[A-Z]\w*Error)(?::\s?(.*))?$/;

export function parseTraceback(stderr, root = '/project') {
  const lines = stderr.replace(/\s+$/, '').split('\n');
  let start = -1;
  lines.forEach((l, i) => {
    if (l.startsWith('Traceback (most recent call last)')) start = i;
  });
  if (start < 0) return null;
  let frame = null;
  for (const line of lines.slice(start)) {
    const m = FRAME.exec(line);
    if (!m || !m[1].startsWith(`${root}/`)) continue;
    frame = { path: m[1].slice(root.length + 1), line: Number(m[2]), function: (m[3] || '').trim() };
  }
  const last = [...lines.slice(start)].reverse().find((l) => l && !l.startsWith(' ')) || '';
  const m = EXC.exec(last.trim());
  const type = m ? m[1] : last.split(':')[0] || 'Error';
  const message = m ? m[2] || '' : last;
  return { type: type.split('.').pop(), message: message.trim(), ...(frame || {}) };
}
