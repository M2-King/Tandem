import { useCallback, useEffect, useState } from 'react';
import { DESKTOP } from '../runtime/desktop.js';

export const MATERIAL_LABELS = {
  acrylic: { label: 'Frosted', description: 'Your desktop, softly blurred (Windows acrylic)' },
  mica: { label: 'Mica', description: 'Tinted by your wallpaper (Windows Mica)' },
  vibrancy: { label: 'Frosted', description: 'Your desktop, softly blurred' },
  clear: { label: 'Clear', description: 'Your desktop exactly as it is, behind tinted glass' },
};

// Desktop window state: material, maximized, wallpaper brightness.
export function useDesktop(notify) {
  const [info, setInfo] = useState(null);
  const [maximized, setMaximized] = useState(false);
  const [luminance, setLuminance] = useState(null);

  useEffect(() => {
    if (!DESKTOP) return undefined;
    let live = true;
    DESKTOP.info().then((i) => {
      if (!live) return;
      setInfo(i);
      setMaximized(i.maximized);
      setLuminance(i.wallpaperLuminance);
    });
    const offs = [DESKTOP.onMaximized(setMaximized), DESKTOP.onWallpaper((l) => l != null && setLuminance(l))];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!DESKTOP) return;
    document.documentElement.dataset.material = info?.material || '';
    document.documentElement.dataset.maximized = maximized ? 'true' : 'false';
  }, [info, maximized]);

  // Switching to or from Clear reopens the window in place (the page
  // reloads), so it waits while code is running.
  const setMaterial = useCallback(
    async (material, { busy = false } = {}) => {
      const current = info?.material;
      if (material === current) return;
      if (busy && (material === 'clear' || current === 'clear')) {
        notify(`Stop the run first: switching to ${MATERIAL_LABELS[material].label} glass reopens the window.`);
        return;
      }
      const result = await DESKTOP.setMaterial(material);
      if (result.applied && !result.replaced) setInfo((i) => ({ ...i, material }));
    },
    [notify, info]
  );

  return { active: !!DESKTOP, info, maximized, luminance, setMaterial };
}
