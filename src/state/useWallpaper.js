import { useCallback, useEffect, useState } from 'react';
import { loadJSON, saveJSON, STORAGE_KEYS } from '../lib/storage.js';

// The backdrop behind the glass panels. Tandem ships with a sunset ("dusk");
// people can switch to a plain background or use their own image, which is
// kept in this browser only.

const MAX_EDGE = 2400; // keeps a stored photo to a few hundred KB
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const DEFAULT = { kind: 'dusk' };

function apply(wallpaper) {
  const body = document.body;
  body.dataset.wallpaper = wallpaper.kind === 'custom' && !wallpaper.custom?.image ? 'dusk' : wallpaper.kind;
  const custom = wallpaper.custom;
  if (wallpaper.kind === 'custom' && custom?.image) {
    body.style.setProperty('--wallpaper-image', `url("${custom.image}")`);
    body.style.setProperty('--wallpaper-dim', String(custom.dim ?? 0.3));
  } else {
    body.style.removeProperty('--wallpaper-image');
    body.style.removeProperty('--wallpaper-dim');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    img.src = url;
  });
}

// Bright photos need more shade so light text on the glass stays readable.
function dimFor(img) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  const lum = sum / (data.length / 4);
  return Math.round(Math.min(0.62, Math.max(0.18, 0.18 + (lum - 0.3) * 0.9)) * 100) / 100;
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
    return { image: c.toDataURL('image/jpeg', 0.85), dim: dimFor(img), name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useWallpaper(notify) {
  const [wallpaper, setWallpaper] = useState(() => {
    const saved = loadJSON(STORAGE_KEYS.wallpaper, DEFAULT);
    return saved && ['dusk', 'plain', 'custom'].includes(saved.kind) ? saved : DEFAULT;
  });

  useEffect(() => apply(wallpaper), [wallpaper]);

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

  return { wallpaper, choose, pickImage };
}
