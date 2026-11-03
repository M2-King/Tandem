// Simulated Python execution.
//
// FUTURE INTEGRATION: replace `startRun` with a call to a real Python
// runner (for example a server endpoint or Pyodide in a web worker). Keep
// the same callbacks: stream output lines with onOutput, then call
// onFinish with a result object of the same shape.
//
// The mock recognises the sample files (and the versions the assistant can
// produce) and replays prepared results. Any other code is reported as
// "not supported by the demo" instead of pretending it ran.

import {
  MAIN_BASELINE,
  MAIN_COMPARE,
  MAIN_COMBINED,
  SUMMARY_BUG,
  SUMMARY_FIXED,
  PRICE_STATS,
  HOUSING_CSV,
} from '../data/sampleProject.js';
import {
  TEST_ACTUAL,
  LINEAR_PRED,
  TREE_PRED,
  LINEAR_COEFFICIENTS,
  TRAIN_COUNT,
  TEST_COUNT,
  parseHousing,
} from '../data/sampleResults.js';
import { regressionMetrics } from '../lib/metrics.js';
import { normalizeCode, normalizeWhitespace } from '../lib/text.js';

const KNOWN_VERSIONS = [
  { path: 'main.py', key: 'main-baseline', label: 'Sample', code: MAIN_BASELINE },
  { path: 'main.py', key: 'main-compare', label: 'Model comparison', code: MAIN_COMPARE },
  { path: 'main.py', key: 'main-combined', label: 'Combined chart', code: MAIN_COMBINED },
  { path: 'summary.py', key: 'summary-bug', label: 'Sample', code: SUMMARY_BUG },
  { path: 'summary.py', key: 'summary-fixed', label: 'Fixed column name', code: SUMMARY_FIXED },
  { path: 'price_stats.py', key: 'stats', label: 'Sample', code: PRICE_STATS },
];

// Which known version is this code? Comments and blank lines are ignored.
export function identifyVersion(path, code) {
  const normalized = normalizeCode(code);
  return KNOWN_VERSIONS.find((v) => v.path === path && normalizeCode(v.code) === normalized) || null;
}

export function datasetIsOriginal(files) {
  return normalizeWhitespace(files['data/housing.csv'] || '') === normalizeWhitespace(HOUSING_CSV);
}

// Which file does Run execute? The active Python file, or main.py.
export function runTargetFor(activePath) {
  return activePath && activePath.endsWith('.py') ? activePath : 'main.py';
}

/* ---------- formatting helpers that mimic Python's output ---------- */

const fmt = (n, digits) => n.toFixed(digits);
const signed = (n, digits) => (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(digits);
const pyList = (arr) => '[' + arr.join(', ') + ']';
const arrayPreview = (arr) => 'array([' + arr.slice(0, 4).map((v) => v.toFixed(1)).join(', ') + ', …])';

/* ---------- figures (rendered by components/ScatterChart.jsx) ---------- */

function sizePriceFigure() {
  const { rows } = parseHousing();
  return {
    id: 'size-price',
    title: 'Price vs. size',
    panels: [
      {
        title: 'Price vs. size',
        xLabel: 'Size (sq ft)',
        yLabel: 'Price ($k)',
        diagonal: false,
        series: [
          {
            name: 'Homes',
            color: 'series1',
            shape: 'circle',
            points: rows.map((r) => ({ x: r.size_sqft, y: r.price_k })),
          },
        ],
      },
    ],
  };
}

const predictionPoints = (pred) => TEST_ACTUAL.map((actual, i) => ({ x: actual, y: pred[i] }));

function sideBySideFigure() {
  // matplotlib colours each subplot with the first colour of its cycle, so
  // both panels use the same blue circles here.
  const panel = (title, pred) => ({
    title,
    xLabel: 'Actual price ($k)',
    yLabel: 'Predicted price ($k)',
    diagonal: true,
    series: [{ name: title, color: 'series1', shape: 'circle', points: predictionPoints(pred) }],
  });
  return {
    id: 'pred-actual',
    title: 'Predicted vs. actual price',
    panels: [panel('Linear regression', LINEAR_PRED), panel('Decision tree', TREE_PRED)],
  };
}

function combinedFigure() {
  return {
    id: 'pred-actual-combined',
    title: 'Predicted vs. actual price',
    panels: [
      {
        title: 'Predicted vs. actual price',
        xLabel: 'Actual price ($k)',
        yLabel: 'Predicted price ($k)',
        diagonal: true,
        legend: true,
        series: [
          { name: 'Linear regression', color: 'series1', shape: 'circle', points: predictionPoints(LINEAR_PRED) },
          { name: 'Decision tree', color: 'series2', shape: 'square', points: predictionPoints(TREE_PRED) },
        ],
      },
    ],
  };
}

/* ---------- prepared results for each known version ---------- */

function mainCommonOutput() {
  const lines = [
    'Loaded 40 homes with columns: size_sqft, bedrooms, age_years, price_k',
    `Trained on ${TRAIN_COUNT} homes, testing on ${TEST_COUNT}`,
  ];
  for (const [name, coef] of Object.entries(LINEAR_COEFFICIENTS)) {
    lines.push(`  ${name.padStart(10)}: ${signed(coef, 2)}`);
  }
  return lines;
}

const mainCommonVariables = () => [
  { name: 'df', type: 'DataFrame', value: '40 rows × 4 columns' },
  { name: 'features', type: 'list', value: "['size_sqft', 'bedrooms', 'age_years']" },
  { name: 'X_train', type: 'DataFrame', value: `${TRAIN_COUNT} rows × 3 columns` },
  { name: 'X_test', type: 'DataFrame', value: `${TEST_COUNT} rows × 3 columns` },
  { name: 'y_test', type: 'Series', value: `${TEST_COUNT} values, ${TEST_ACTUAL.slice(0, 3).join(', ')}, …` },
  { name: 'model', type: 'LinearRegression', value: 'LinearRegression()' },
];

function mainBaselineResult() {
  const linear = regressionMetrics(TEST_ACTUAL, LINEAR_PRED);
  return {
    status: 'success',
    output: [...mainCommonOutput(), `Test R²: ${fmt(linear.r2, 3)}`],
    variables: mainCommonVariables(),
    figures: [sizePriceFigure()],
    metrics: { 'Linear regression': { r2: linear.r2 } },
  };
}

function mainCompareResult(combined) {
  const models = {
    'Linear regression': regressionMetrics(TEST_ACTUAL, LINEAR_PRED),
    'Decision tree': regressionMetrics(TEST_ACTUAL, TREE_PRED),
  };
  const output = [...mainCommonOutput(), '', 'Model comparison on test data'];
  for (const [name, m] of Object.entries(models)) {
    output.push(
      `  ${name.padEnd(18)} MAE ${fmt(m.mae, 1).padStart(5)}  RMSE ${fmt(m.rmse, 1).padStart(5)}  R² ${fmt(m.r2, 3)}`
    );
  }
  const last = models['Decision tree']; // loop variables keep the last values
  return {
    status: 'success',
    output,
    variables: [
      ...mainCommonVariables(),
      { name: 'tree', type: 'DecisionTreeRegressor', value: 'DecisionTreeRegressor(max_depth=4, random_state=42)' },
      { name: 'linear_pred', type: 'ndarray', value: `shape (10,)  ${arrayPreview(LINEAR_PRED)}` },
      { name: 'tree_pred', type: 'ndarray', value: `shape (10,)  ${arrayPreview(TREE_PRED)}` },
      { name: 'mae', type: 'float', value: fmt(last.mae, 4) },
      { name: 'rmse', type: 'float', value: fmt(last.rmse, 4) },
      { name: 'r2', type: 'float', value: fmt(last.r2, 4) },
    ],
    figures: [sizePriceFigure(), combined ? combinedFigure() : sideBySideFigure()],
    metrics: models,
  };
}

function summaryErrorResult() {
  return {
    status: 'error',
    output: [
      { text: 'Traceback (most recent call last):', kind: 'err' },
      { text: '  File "summary.py", line 7, in <module>', kind: 'err' },
      { text: '    summary = df.groupby("bedrooms")["price"].agg(["count", "mean"])', kind: 'err' },
      { text: '  File ".../site-packages/pandas/core/groupby/generic.py", in __getitem__', kind: 'err' },
      { text: '    return super().__getitem__(key)', kind: 'err' },
      { text: '  File ".../site-packages/pandas/core/base.py", in __getitem__', kind: 'err' },
      { text: '    raise KeyError(f"Column not found: {key}")', kind: 'err' },
      { text: "KeyError: 'Column not found: price'", kind: 'err' },
    ],
    variables: [{ name: 'df', type: 'DataFrame', value: '40 rows × 4 columns' }],
    figures: [],
    metrics: null,
    error: {
      type: 'KeyError',
      message: "Column not found: price",
      path: 'summary.py',
      line: 7,
      explanation: 'Line 7 asks for a column named "price", but housing.csv names it "price_k".',
    },
  };
}

function summaryFixedResult() {
  // Same calculation pandas does: count and mean price per bedroom count.
  const { rows } = parseHousing();
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.bedrooms) || [];
    g.push(r.price_k);
    groups.set(r.bedrooms, g);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const table = keys.map((k) => {
    const prices = groups.get(k);
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    return { k, count: prices.length, mean: (Math.round(mean * 10) / 10).toFixed(1) };
  });
  const cw = Math.max(5, ...table.map((r) => String(r.count).length));
  const mw = Math.max(4, ...table.map((r) => r.mean.length));
  const output = [
    'Average price by bedrooms ($k)',
    ' '.repeat(8) + '  ' + 'count'.padStart(cw) + '  ' + 'mean'.padStart(mw),
    'bedrooms'.padEnd(8 + 2 + cw + 2 + mw),
    ...table.map((r) => String(r.k).padEnd(8) + '  ' + String(r.count).padStart(cw) + '  ' + r.mean.padStart(mw)),
  ];
  return {
    status: 'success',
    output,
    variables: [
      { name: 'df', type: 'DataFrame', value: '40 rows × 4 columns' },
      { name: 'summary', type: 'DataFrame', value: `${table.length} rows × 2 columns (count, mean)` },
    ],
    figures: [],
    metrics: null,
  };
}

function priceStatsResult() {
  return {
    status: 'success',
    output: ['Mean price: 382.5', 'Above mean: ' + pyList([425, 515])],
    variables: [
      { name: 'prices', type: 'list', value: pyList([310, 425, 280, 515]) },
      { name: 'average', type: 'function', value: '<function average>' },
      { name: 'mean_price', type: 'float', value: '382.5' },
      { name: 'above_mean', type: 'list', value: pyList([425, 515]) },
      { name: 'price', type: 'int', value: '515' },
    ],
    figures: [],
    metrics: null,
  };
}

function resultFor(version) {
  switch (version.key) {
    case 'main-baseline':
      return mainBaselineResult();
    case 'main-compare':
      return mainCompareResult(false);
    case 'main-combined':
      return mainCompareResult(true);
    case 'summary-bug':
      return summaryErrorResult();
    case 'summary-fixed':
      return summaryFixedResult();
    default:
      return priceStatsResult();
  }
}

// Explain why the demo can't run this code, without inventing output.
export function checkRunnable(path, files) {
  const version = identifyVersion(path, files[path] ?? '');
  if (!version) {
    return {
      ok: false,
      title: `The demo can't run this version of ${path}`,
      detail:
        'Python execution is simulated with prepared results for the sample files and the changes the assistant proposes. Your edits are saved, but they were not executed.',
    };
  }
  if (path !== 'price_stats.py' && !datasetIsOriginal(files)) {
    return {
      ok: false,
      title: 'The demo needs the original housing.csv',
      detail: 'Prepared results are based on the sample dataset. Your edits to data/housing.csv are saved, but no results were produced from them.',
      resetPath: 'data/housing.csv',
    };
  }
  return { ok: true, version };
}

// Start a simulated run. Returns { stop } to cancel it.
export function startRun({ path, files, onOutput, onFinish }) {
  const check = checkRunnable(path, files);
  if (!check.ok) throw new Error('startRun called with code the demo cannot run');

  const result = resultFor(check.version);
  const lines = result.output.map((l) => (typeof l === 'string' ? { text: l, kind: 'out' } : l));
  const timers = [];
  const startedAt = Date.now();
  let index = 0;
  let finished = false;

  // Simulate a short start-up (imports), then stream lines.
  const schedule = (delay) => timers.push(setTimeout(tick, delay));
  function tick() {
    if (index < lines.length) {
      onOutput(lines[index]);
      index += 1;
      // pause a little longer where real code would be "working"
      const slow = /^Trained|^Model comparison|^Traceback/.test(lines[index]?.text || '');
      schedule(slow ? 520 : 140);
    } else {
      finished = true;
      onFinish({ ...result, output: lines, version: check.version, durationMs: Date.now() - startedAt });
    }
  }
  schedule(650);

  return {
    stop() {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      onFinish({
        status: 'stopped',
        output: lines.slice(0, index),
        variables: [],
        figures: [],
        metrics: null,
        version: check.version,
        durationMs: Date.now() - startedAt,
      });
    },
  };
}
