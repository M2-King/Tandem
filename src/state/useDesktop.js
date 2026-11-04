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

  const setMaterial = useCallback(
    async (material) => {
      const result = await DESKTOP.setMaterial(material);
      if (result.applied) setInfo((i) => ({ ...i, material }));
      else if (result.restart) {
        notify(`${MATERIAL_LABELS[material].label} glass applies when Tandem restarts.`, {
          label: 'Restart now',
          onClick: () => DESKTOP.restart(),
        });
      }
    },
    [notify]
  );

  return { active: !!DESKTOP, info, maximized, luminance, setMaterial };
}
