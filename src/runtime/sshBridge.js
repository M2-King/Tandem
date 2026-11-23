// "Connect to SSH server…": the app (desktop or iPad) shows its own connect
// window or sheet and does the connecting; the page only asks. Passwords and
// keys never pass through the page. Null where there is no app (a browser).
import { DESKTOP } from './desktop.js';

function ipadBridge() {
  const handler = typeof window !== 'undefined' ? window.webkit?.messageHandlers?.tandemSSH : null;
  if (!handler) return null;
  return {
    connect: () => handler.postMessage({ type: 'connect' }),
    disconnect: () => handler.postMessage({ type: 'disconnect' }),
  };
}

export const SSH = DESKTOP?.ssh || ipadBridge();
