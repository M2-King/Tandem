import { useCallback, useEffect, useState } from 'react';
import { loadJSON, saveJSON, STORAGE_KEYS } from '../lib/storage.js';

// The backdrop behind the glass panels. Tandem ships with a sunset ("dusk");
// people can switch to a plain background or use their own image, which is
// kept in this browser only.
//
// The wallpaper is shown exactly as chosen: no blur, tint or dimming. Instead
// its average brightness is measured, and the glass material adapts to it
// (see lib/glass.js), so text stays readable over light and dark images.

const MAX_EDGE = 2400; // keeps a stored photo to a few hundred KB
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const DEFAULT = { kind: 'dusk' };

const DUSK_URL = `${import.meta.env.BASE_URL}bg-dusk.svg`;
const PLAIN_LUMINANCE = 0.05; // the plain backdrop is near-black

const activeKind = (wallpaper) => (wallpaper.kind === 'custom' && !wallpaper.custom?.image ? 'dusk' : wallpaper.kind);

function apply(wallpaper) {
  const body = document.body;
  body.dataset.wallpaper = activeKind(wallpaper);
  const custom = wallpaper.custom;
  if (wallpaper.kind === 'custom' && custom?.image) body.style.setProperty('--wallpaper-image', `url("${custom.image}")`);
  else body.style.removeProperty('--wallpaper-image');
}

function loadURL(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = src;
  });
}

function loadImage(file) {
  const url = URL.createObjectURL(file);
  return loadURL(url).then(
    (img) => ({ img, url }),
    (e) => {
      URL.revokeObjectURL(url);
      throw e;
    }
  );
}

// Perceived brightness, 0 (black) to 1 (white). Bright patches matter more
// than the average (a yellow sun behind the editor hurts contrast even if the
// rest is dark), so this blends the mean with the 80th percentile.
function luminanceOf(img) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  const values = [];
  for (let i = 0; i < data.length; i += 4) {
    values.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
  }
  values.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const high = values[Math.floor(values.length * 0.8)];
  return Math.round(((mean + high) / 2) * 100) / 100;
}

async function prepare(file) {
  if (!file.type.startsWith('image/')) throw new Error('not-image');
  if (file.size > MAX_FILE_BYTES) throw new Error('too-big');
  const { img, url } = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { image: c.toDataURL('image/jpeg', 0.85), luminance2: luminanceOf(img), name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useWallpaper(notify) {
  const [wallpaper, setWallpaper] = useState(() => {
    const saved = loadJSON(STORAGE_KEYS.wallpaper, DEFAULT);
    return saved && ['dusk', 'plain', 'custom'].includes(saved.kind) ? saved : DEFAULT;
  });

  const [luminance, setLuminance] = useState(0.3);

  useEffect(() => {
    apply(wallpaper);
    const kind = activeKind(wallpaper);
    if (kind === 'plain') {
      setLuminance(PLAIN_LUMINANCE);
      return undefined;
    }
    if (kind === 'custom' && typeof wallpaper.custom.luminance2 === 'number') {
      setLuminance(wallpaper.custom.luminance2);
      return undefined;
    }
    // Measure the default image, or a custom image saved before brightness was stored.
    let live = true;
    loadURL(kind === 'custom' ? wallpaper.custom.image : DUSK_URL)
      .then((img) => live && setLuminance(luminanceOf(img)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wallpaper]);

  // Switching to dusk or plain keeps the person's image so they can switch back.
  const choose = useCallback((kind) => {
    setWallpaper((w) => {
      const next = { ...w, kind };
      saveJSON(STORAGE_KEYS.wallpaper, next);
      return next;
    });
  }, []);

  const pickImage = useCallback(
    async (file) => {
      if (!file) return;
      let custom;
      try {
        custom = await prepare(file);
      } catch (e) {
        notify(
          e.message === 'not-image'
            ? `${file.name} isn't an image. Choose a JPG, PNG or WebP file.`
            : e.message === 'too-big'
              ? `${file.name} is larger than 25 MB. Choose a smaller image.`
              : `${file.name} couldn't be opened as an image.`
        );
        return;
      }
      const next = { kind: 'custom', custom };
      setWallpaper(next);
      if (saveJSON(STORAGE_KEYS.wallpaper, next)) {
        notify('Wallpaper updated. It is saved in this browser only.');
      } else {
        notify('Wallpaper set for this visit. The image is too large to save in this browser.');
      }
    },
    [notify]
  );

  return { wallpaper, luminance, choose, pickImage };
}
