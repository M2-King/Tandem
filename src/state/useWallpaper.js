import { useCallback, useEffect, useState } from 'react';
import { loadJSON, saveJSON, STORAGE_KEYS } from '../lib/storage.js';
import { IS_IPAD } from '../runtime/config.js';

// The backdrop behind the glass panels. Tandem ships with a sunset ("dusk");
// people can switch to a plain background or use their own image, which is
// kept in this browser only.
//
// On iPad the app can't show the Home Screen wallpaper behind itself, so people
// pick their wallpaper photo instead. The app keeps it (not the page), and the
// image is drawn the way iPadOS draws the wallpaper: filling the whole screen,
// lined up with where this window is, so it continues the real wallpaper
// around the window and the glass looks see-through.
//
// The wallpaper is shown exactly as chosen: no blur, tint or dimming. Instead
// its average brightness is measured, and the glass material adapts to it
// (see lib/glass.js), so text stays readable over light and dark images.

const MAX_EDGE = IS_IPAD ? 2800 : 2400; // keeps a stored photo to a few hundred KB (iPad: screen sharp)
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// On iPad: plain until the person picks their wallpaper photo.
const DEFAULT = { kind: IS_IPAD ? 'plain' : 'dusk' };

const DUSK_URL = `${import.meta.env.BASE_URL}bg-dusk.svg`;
const PLAIN_LUMINANCE = 0.05; // the plain backdrop is near-black

const activeKind = (wallpaper) => (wallpaper.kind === 'custom' && !wallpaper.custom?.image ? 'dusk' : wallpaper.kind);

function apply(wallpaper) {
  const body = document.body;
  body.dataset.wallpaper = activeKind(wallpaper);
  const custom = wallpaper.custom;
  if (wallpaper.kind === 'custom' && custom?.image) body.style.setProperty('--wallpaper-image', `url("${custom.image}")`);
  else body.style.removeProperty('--wallpaper-image');
  alignToScreen(wallpaper);
}

// iPad: draw the photo like the Home Screen does (cover the screen, centred)
// and shift it by this window's place on the screen. The app reports that
// place in window.__tandemScreen, in points (= CSS pixels here).
export function screenAlignment(screen, width, height) {
  if (!screen || !(width > 0) || !(height > 0) || !(screen.sw > 0) || !(screen.sh > 0)) return null;
  const scale = Math.max(screen.sw / width, screen.sh / height);
  const w = width * scale;
  const h = height * scale;
  const round = (n) => Math.round(n * 10) / 10;
  return { size: `${round(w)}px ${round(h)}px`, position: `${round((screen.sw - w) / 2 - screen.x)}px ${round((screen.sh - h) / 2 - screen.y)}px` };
}

function alignToScreen(wallpaper) {
  const body = document.body;
  const custom = wallpaper.custom;
  const fit =
    IS_IPAD && wallpaper.kind === 'custom' && custom?.image
      ? screenAlignment(window.__tandemScreen, custom.width, custom.height)
      : null;
  if (fit) {
    body.dataset.wallpaperFit = 'screen';
    body.style.setProperty('--wallpaper-size', fit.size);
    body.style.setProperty('--wallpaper-position', fit.position);
  } else {
    delete body.dataset.wallpaperFit;
    body.style.removeProperty('--wallpaper-size');
    body.style.removeProperty('--wallpaper-position');
  }
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
    return {
      image: c.toDataURL('image/jpeg', 0.88),
      luminance2: luminanceOf(img),
      name: file.name,
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// What the page itself remembers. On iPad the photo is kept by the app.
const remembered = (wallpaper) => (IS_IPAD ? { kind: wallpaper.kind } : wallpaper);

// store: on iPad, the app's wallpaper storage ({ loadWallpaper, saveWallpaper }).
export function useWallpaper(notify, store = null) {
  const [wallpaper, setWallpaper] = useState(() => {
    const saved = loadJSON(STORAGE_KEYS.wallpaper, DEFAULT);
    return saved && ['dusk', 'plain', 'custom'].includes(saved.kind) ? saved : DEFAULT;
  });

  // iPad: fetch the photo the app keeps. With no remembered choice, a saved
  // photo is used (the page's own storage can be lost; the app's isn't).
  useEffect(() => {
    if (!store) return undefined;
    let live = true;
    store.loadWallpaper().then(
      (custom) => {
        if (!live || !custom?.image) return;
        setWallpaper(() => ({ kind: loadJSON(STORAGE_KEYS.wallpaper, null)?.kind ?? 'custom', custom }));
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [store]);

  // iPad: follow the window as it moves, resizes and rotates.
  useEffect(() => {
    if (!IS_IPAD) return undefined;
    const update = () => alignToScreen(wallpaper);
    window.addEventListener('tandem-screen', update);
    return () => window.removeEventListener('tandem-screen', update);
  }, [wallpaper]);

  // Photos saved before their size was stored: measure once.
  useEffect(() => {
    const custom = wallpaper.custom;
    if (!IS_IPAD || !custom?.image || custom.width) return undefined;
    let live = true;
    loadURL(custom.image)
      .then((img) => {
        if (!live) return;
        setWallpaper((w) =>
          w.custom === custom ? { ...w, custom: { ...custom, width: img.naturalWidth, height: img.naturalHeight } } : w
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [wallpaper]);

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
      saveJSON(STORAGE_KEYS.wallpaper, remembered(next));
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
      if (store) {
        saveJSON(STORAGE_KEYS.wallpaper, remembered(next));
        try {
          await store.saveWallpaper(custom);
          notify('Wallpaper set. It lines up with your screen wherever the window is.');
        } catch (e) {
          notify(`Wallpaper set for now, but Tandem couldn't keep it: ${e.message}`);
        }
        return;
      }
      if (saveJSON(STORAGE_KEYS.wallpaper, next)) {
        notify('Wallpaper updated. It is saved in this browser only.');
      } else {
        notify('Wallpaper set for this visit. The image is too large to save in this browser.');
      }
    },
    [notify, store]
  );

  return { wallpaper, luminance, choose, pickImage };
}
