import { createContext, useContext } from 'react';
import { IS_LOCAL } from '../runtime/config.js';

// How run results are labelled. Real runs (the local runtime, the iPad) carry
// no label; the demo's prepared results say "Simulated"; the Cowork preview
// says "Preview" (sample results played back "on this device").
export const DEMO_RUN_MODE = IS_LOCAL
  ? { real: true, tag: null, tagTip: null, running: 'Running', sample: '' }
  : {
      real: false,
      tag: 'Simulated',
      tagTip: 'Python execution is simulated with prepared sample results.',
      running: 'Running (simulated)',
      sample: ' · sample data',
    };

export const COWORK_RUN_MODE = {
  real: true,
  tag: 'Preview',
  tagTip: 'Cowork preview: runs play back prepared sample results. In Cowork, Python runs on this device.',
  running: 'Running on this device',
  sample: ' · sample result',
};

export const RunModeContext = createContext(DEMO_RUN_MODE);
export const useRunMode = () => useContext(RunModeContext);
