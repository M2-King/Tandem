// Tandem for iPad: the page fills the app's whole window, edge to edge, like
// the desktop app's Clear window. It keeps its controls clear of the status
// bar and of the window buttons iPadOS draws in the top-left corner, and fits
// itself above the on-screen keyboard instead of being scrolled by it.
import { IS_IPAD } from './config.js';

export function setupIpadShell() {
  if (!IS_IPAD) return;
  const root = document.documentElement;
  root.dataset.shell = 'ipad';

  // Content runs under the status bar (CSS env(safe-area-inset-*) keeps controls clear).
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return;
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }

  // A window smaller than the screen has the window buttons over its top-left corner.
  const windowed = () => {
    const g = window.__tandemScreen;
    const value = g ? String(g.w < g.sw - 1 || g.h < g.sh - 1) : 'false';
    if (root.dataset.windowed !== value) root.dataset.windowed = value;
  };
  window.addEventListener('tandem-screen', windowed);
  windowed();
}
