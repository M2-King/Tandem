// The glass material. Two settings a person can change, plus one input the
// app measures:
//
//   level      Opacity, 0 (clearest) to 100 (most solid). Presets are named
//              points on this scale, so the slider and presets agree.
//   frost      How strongly the window glass diffuses what is behind it.
//   luminance  Average brightness of the current wallpaper, 0 to 1. The
//              wallpaper itself is never filtered; instead, over a bright
//              image the window glass passes less light and gets denser, so
//              text keeps its contrast. Over a dark image nothing changes.
//
// Only the window glass blurs. Panes inside it are plain translucent sheets,
// so the result stays crisp instead of blurring blur.

export const GLASS_PRESETS = [
  { id: 'clear', label: 'Clear', level: 15 },
  { id: 'balanced', label: 'Balanced', level: 50 },
  { id: 'solid', label: 'Solid', level: 90 },
];
export const DEFAULT_GLASS = 50;
export const DEFAULT_FROST = 50;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(', ')})`;

export function glassVariables(level, frost = DEFAULT_FROST, luminance = 0.3) {
  const t = clamp01((Number(level) || 0) / 100);
  const f = clamp01((Number(frost) || 0) / 100);
  // 0 for dark wallpapers, 1 for very bright ones.
  const bright = clamp01((luminance - 0.25) / 0.4);
  // Bright wallpapers add density, less so as the glass is already solid.
  const extra = bright * (1 - t);
  return {
    '--window-opacity': round(Math.min(0.94, lerp(0.18, 0.8, t) + 0.44 * extra)),
    '--window-blur': `${round(lerp(8, 36, f), 1)}px`,
    // Light passing through the window glass, not a filter on the wallpaper.
    '--glass-transmission': round(lerp(0.88, 0.42, bright)),
    // The document panes darken further, so code and charts read first.
    '--content-opacity': round(Math.min(0.92, lerp(0.34, 0.82, t) + 0.16 * extra)),
    '--glass-opacity-float': round(Math.min(0.97, lerp(0.84, 0.96, t) + 0.1 * extra)),
    // The faintest text steps up toward the secondary grey over bright images.
    '--text-muted': mix([140, 147, 161], [160, 167, 180], bright),
  };
}

export function presetFor(level) {
  return GLASS_PRESETS.find((p) => p.level === level)?.id ?? null;
}

const clamp100 = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;

// Older saved preferences stored a preset name.
export function normalizeGlass(value) {
  if (typeof value === 'string') return GLASS_PRESETS.find((p) => p.id === value)?.level ?? DEFAULT_GLASS;
  return clamp100(value, DEFAULT_GLASS);
}
export const normalizeFrost = (value) => clamp100(value, DEFAULT_FROST);

export function applyGlass(level, frost, luminance) {
  const root = document.documentElement;
  const vars = glassVariables(level, frost, luminance);
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, String(v)));
  root.dataset.glass = presetFor(level) ?? 'custom';
}
