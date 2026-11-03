// Simulated AI assistant.
//
// FUTURE INTEGRATION: replace `sendAssistantRequest` with a call to your AI
// backend. Keep the same inputs (prompt, intent, context, files, signal,
// onStage) and return one of these result shapes:
//
//   { kind: 'proposal', text, path, newContent, summary: [..] }
//   { kind: 'answer', text }
//   { kind: 'limitation', text, suggestions: [..], action? }
//
// The proposal's base content is captured by the caller, so stale-change
// protection keeps working with a real backend. API keys belong on a
// server, never in this frontend.
//
// The mock only handles a few prepared requests and says so honestly for
// anything else.

import {
  MAIN_BASELINE,
  MAIN_COMPARE,
  MAIN_COMBINED,
} from '../data/sampleProject.js';
import { normalizeWhitespace } from '../lib/text.js';

export const DEMO_PROMPTS = {
  compare:
    'Add predictions for the test data, plot predicted versus actual values, and compare the model with a decision tree.',
  sameChart: 'Show both models in the same chart.',
  fixSummary: 'Fix the error in summary.py.',
  explainMain: 'Explain what main.py does.',
};

const BUGGY_CALL = 'df.groupby("bedrooms")["price"]';
const FIXED_CALL = 'df.groupby("bedrooms")["price_k"]';

// Wait that can be cancelled with an AbortSignal.
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    });
  });
}

const same = (a, b) => normalizeWhitespace(a) === normalizeWhitespace(b);

/* ---------- request classification ---------- */

function classify(prompt, intent, context) {
  if (intent === 'explain') return 'explain';
  if (intent === 'fix') return 'fix';
  const p = prompt.toLowerCase();
  const hasChart = context.some((c) => c.type === 'chart');
  if (/(same|one|single|combined?|shared) (chart|plot|figure|graph)|overlay|combine/.test(p)) return 'sameChart';
  if (hasChart && /\bboth\b/.test(p)) return 'sameChart';
  if (/decision tree|predict/.test(p)) return 'compare';
  if (/\bfix\b|error|keyerror|bug|broken/.test(p) || context.some((c) => c.type === 'error')) return 'fix';
  if (/^(explain|what does|what is|how does|why|walk me through)/.test(p.trim())) return 'explain';
  return 'unsupported';
}

/* ---------- explanations for the sample files ---------- */

const EXPLANATIONS = [
  [/read_csv/, 'Loads `data/housing.csv` into a DataFrame: 40 homes with size, bedrooms, age, and price (in $k).'],
  [/features = |X = df|y = df/, 'Picks the three input columns as `X` and the price as the target `y`.'],
  [/train_test_split/, 'Holds back 25% of the homes (10) for testing. `random_state=42` makes the split repeatable.'],
  [/LinearRegression\(\)|model\.fit/, 'Fits a linear regression that predicts price from size, bedrooms, and age.'],
  [/coef_/, 'Prints the learned coefficient for each feature: the change in predicted price per unit.'],
  [/model\.score/, '`model.score` returns R² on the test homes. 1.0 means perfect predictions; 0 means no better than the average price.'],
  [/DecisionTreeRegressor/, 'Trains a decision tree (at most 4 levels deep) on the same training data, as a second model to compare.'],
  [/\.predict\(/, 'Predicts prices for the 10 test homes with each model.'],
  [/mean_absolute_error|r2_score|rmse/, 'Prints MAE and RMSE (average error in $k; lower is better) and R² for each model.'],
  [/plt\.(scatter|subplots|figure)/, 'Draws a scatter plot. In predicted-vs-actual plots, points on the dashed line are perfect predictions.'],
  [/groupby/, 'Groups homes by bedroom count and calculates how many there are and their mean price.'],
  [/def average|total = total/, '`average` adds the values up in a loop and divides by how many there are.'],
  [/above_mean|price > mean_price/, 'Collects every price that is higher than the mean.'],
  [/print\(/, 'Prints results to the Output panel.'],
];

function explain(text, label) {
  const bullets = [];
  for (const [pattern, sentence] of EXPLANATIONS) {
    if (pattern.test(text) && !bullets.includes(sentence)) bullets.push(sentence);
    if (bullets.length === 4) break;
  }
  if (!bullets.length) {
    return {
      kind: 'limitation',
      text: `I don't have a prepared explanation for ${label}. In this demo, explanations cover the sample project code.`,
      suggestions: [DEMO_PROMPTS.explainMain],
    };
  }
  return { kind: 'answer', text: `**${label}**\n` + bullets.map((b) => `- ${b}`).join('\n') };
}

/* ---------- main entry point ---------- */

export async function sendAssistantRequest({ prompt, intent = 'chat', context = [], files, activePath, signal, onStage }) {
  const kind = classify(prompt, intent, context);
  const selection = context.find((c) => c.type === 'selection');
  const errorCtx = context.find((c) => c.type === 'error');

  if (kind === 'explain') {
    const path = selection?.path || activePath || 'main.py';
    onStage(selection ? 'Reading the selected lines' : `Reading ${path}`);
    await wait(900, signal);
    const text = selection ? selection.text : files[path] || '';
    const label = selection ? selection.label : path;
    return explain(text, label);
  }

  if (kind === 'fix') {
    const path = errorCtx?.path || selection?.path || 'summary.py';
    onStage(errorCtx ? `Reading the error and ${path}` : `Reading ${path}`);
    await wait(900, signal);
    const code = files[path] ?? '';
    if (path === 'summary.py' && code.includes(BUGGY_CALL)) {
      onStage('Preparing changes');
      await wait(1000, signal);
      return {
        kind: 'proposal',
        path,
        newContent: code.replace(BUGGY_CALL, FIXED_CALL),
        text: '`housing.csv` has no `price` column. It is called `price_k`.',
        summary: ['Uses `price_k` in the `groupby` on line 7'],
      };
    }
    return {
      kind: 'limitation',
      text:
        path === 'summary.py'
          ? 'summary.py no longer contains the column-name error, so there is nothing for the demo to fix. Run it to check the result.'
          : `I couldn't find a problem to fix in ${path}. In this demo, fixes are prepared for the error in summary.py.`,
      suggestions: path === 'summary.py' ? [] : [DEMO_PROMPTS.fixSummary],
    };
  }

  if (kind === 'compare' || kind === 'sameChart') {
    onStage('Reading main.py and data/housing.csv');
    await wait(1100, signal);
    const code = files['main.py'] ?? '';
    const from = kind === 'compare' ? MAIN_BASELINE : MAIN_COMPARE;
    const to = kind === 'compare' ? MAIN_COMPARE : MAIN_COMBINED;

    if (same(code, from)) {
      onStage('Preparing changes');
      await wait(1300, signal);
      if (kind === 'compare') {
        return {
          kind: 'proposal',
          path: 'main.py',
          newContent: to,
          text: 'This compares linear regression with a decision tree on the 10 test homes.',
          summary: [
            'Trains a `DecisionTreeRegressor` next to the linear model',
            'Predicts prices for the test homes with both models',
            'Prints MAE, RMSE, and R² per model (replaces the single R² line)',
            'Plots predicted vs. actual prices for each model',
          ],
        };
      }
      return {
        kind: 'proposal',
        path: 'main.py',
        newContent: to,
        text: 'Both models now share one predicted-vs-actual chart.',
        summary: [
          'Replaces the two side-by-side plots with a single chart',
          'Circles mark linear regression, squares the decision tree',
          'Adds a legend and a dashed perfect-prediction line',
        ],
      };
    }
    if (same(code, to) || (kind === 'compare' && same(code, MAIN_COMBINED))) {
      return {
        kind: 'answer',
        text:
          kind === 'compare'
            ? 'main.py already trains a decision tree, predicts the test homes, and plots predicted vs. actual prices. Run it to see the comparison.'
            : 'main.py already shows both models in the same chart. Run it to see the result.',
      };
    }
    if (kind === 'sameChart' && same(code, MAIN_BASELINE)) {
      return {
        kind: 'limitation',
        text: "main.py doesn't plot predictions yet, so there is nothing to combine. Add the model comparison first.",
        suggestions: [DEMO_PROMPTS.compare],
      };
    }
    return {
      kind: 'limitation',
      text:
        'main.py has edits this demo change wasn’t prepared for, so I can’t generate it safely. Your edits are kept. Resetting main.py to the sample lets you try the demo change.',
      suggestions: [],
      action: { type: 'reset-file', path: 'main.py', label: 'Reset main.py' },
    };
  }

  // Unsupported free-form request: be honest about the demo's limits.
  onStage('Reading your request');
  await wait(700, signal);
  return {
    kind: 'limitation',
    text:
      'This demo can’t handle that request. Responses are prepared for a few sample tasks, and no AI service is connected. Try one of these:',
    suggestions: [DEMO_PROMPTS.compare, DEMO_PROMPTS.fixSummary, DEMO_PROMPTS.explainMain],
  };
}

