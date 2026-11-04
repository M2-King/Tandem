// Which world this window lives in, decided once when the page loads.
//
// Real mode: the page was served by the local Tandem runtime (`tandem open`),
// which puts a config tag with a session token into index.html. Everything
// runs for real; if the runtime goes away, the app says so and stops. It never
// falls back to simulated results.
//
// Demo mode: anything else (the hosted preview, a plain `npm run dev`). The
// prepared, clearly labelled simulation is used and nothing is executed.

function readConfig() {
  try {
    const el = document.getElementById('tandem-runtime');
    if (!el) return null;
    const config = JSON.parse(el.textContent || '{}');
    return config.mode === 'local' && typeof config.token === 'string' && config.token ? config : null;
  } catch {
    return null;
  }
}

export const RUNTIME_CONFIG = readConfig();
export const IS_LOCAL = RUNTIME_CONFIG !== null;
export const MODE = IS_LOCAL ? 'local' : 'demo';
