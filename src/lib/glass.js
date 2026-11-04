// One "glass level" (0 = clearest, 100 = most solid) drives every surface.
// Presets are named points on the same scale, so the slider and the presets
// always agree.

export const GLASS_PRESETS = [
  { id: 'clear', label: 'Clear', level: 15 },
  { id: 'balanced', label: 'Balanced', level: 50 },
  { id: 'solid', label: 'Solid', level: 90 },
];
export const DEFAULT_GLASS = 50;

const lerp = (a, b, t) => a + (b - a) * t;
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function glassVariables(level) {
  const t = Math.min(100, Math.max(0, Number(level) || 0)) / 100;
  return {
    // The editor always stays more opaque than the panels around it.
    '--glass-opacity-editor': round(lerp(0.86, 1, t)), // 0.93 at Balanced
    '--glass-opacity': round(lerp(0.56, 0.92, t)), // 0.74
    '--glass-opacity-float': round(lerp(0.8, 0.96, t)), // 0.88
    '--glass-blur': `${round(lerp(26, 18, t), 1)}px`, // 22px; clearer glass is more frosted
    '--wallpaper-brightness': round(lerp(1.02, 0.82, t)), // 0.92
  };
}

export function presetFor(level) {
  return GLASS_PRESETS.find((p) => p.level === level)?.id ?? null;
}

// Older saved preferences stored a preset name.
export function normalizeGlass(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(100, Math.max(0, Math.round(value)));
  return GLASS_PRESETS.find((p) => p.id === value)?.level ?? DEFAULT_GLASS;
}

export function applyGlass(level) {
  const root = document.documentElement;
  const vars = glassVariables(level);
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, String(v)));
  root.dataset.glass = presetFor(level) ?? 'custom';
}
