// Keyboard shortcuts: ⌘ on Mac and iPad, Ctrl elsewhere.

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const MAC_SYMBOLS = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Enter: '↩', Backspace: '⌫' };

// "Mod+Shift+F" → "⌘⇧F" (Mac) or "Ctrl+Shift+F".
export function keyLabel(spec) {
  const parts = spec.split('+');
  if (IS_MAC) return parts.map((p) => MAC_SYMBOLS[p] || p).join('');
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+');
}

// Does a keydown match "Mod+Shift+F"? (Letters by key code, so Shift and
// keyboard layouts don't change them; "`" is the Backquote key.)
export function matches(e, spec) {
  const parts = spec.split('+');
  const key = parts.pop();
  const ctrlNamed = parts.includes('Ctrl');
  // On Windows and Linux, Ctrl is the Mod key; on a Mac they are different keys.
  const needMod = parts.includes('Mod') || (!IS_MAC && ctrlNamed);
  const needCtrl = IS_MAC && ctrlNamed;
  if ((IS_MAC ? e.metaKey : e.ctrlKey) !== needMod) return false;
  if (IS_MAC && e.ctrlKey !== needCtrl) return false;
  if (e.shiftKey !== parts.includes('Shift') || e.altKey !== parts.includes('Alt')) return false;
  if (key === '`') return e.code === 'Backquote';
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  return e.key === key;
}
