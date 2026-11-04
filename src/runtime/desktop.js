// Running inside the Tandem desktop app? Its preload exposes `tandemDesktop`
// (a few window actions). In a browser this is null and nothing changes.
export const DESKTOP = typeof window !== 'undefined' ? window.tandemDesktop || null : null;
export const IS_DESKTOP = !!DESKTOP;

if (IS_DESKTOP) {
  // Set before the first paint: the page draws no wallpaper of its own; the
  // person's desktop shows behind the window.
  document.documentElement.dataset.shell = 'desktop';
  document.documentElement.dataset.platform = DESKTOP.platform;
}
