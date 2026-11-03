// Small text helpers shared by the mock services.

// Trim trailing whitespace on each line and at the end of the file, so
// harmless whitespace edits don't count as code changes.
export function normalizeWhitespace(code) {
  return code
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

// Also ignore blank lines and full-line comments. Used to recognise a known
// version of a file even if the user added notes to it.
export function normalizeCode(code) {
  return normalizeWhitespace(code)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n');
}

// Short, stable fingerprint for a file snapshot (shown as "snapshot 3f9a1c").
export function shortHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
