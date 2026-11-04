import { shortHash } from '../lib/text.js';

// After a run of code that Tandem changed, summarise what the run produced.
// Everything here comes from the finished run record, so the assistant never
// reports results before the code has run.

const fmt = (n, d) => (n == null ? '—' : n.toFixed(d));

// The run executed exactly the version Tandem proposed and the person accepted.
export function proposalForRun(run, proposals) {
  return Object.values(proposals).find(
    (p) => p.status === 'accepted' && p.path === run.path && shortHash(p.newContent) === run.snapshotHash
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// A real run: every line states something the run itself recorded (exit
// code, duration, the program's own `results` metrics, figures it showed).
// No units or dataset facts are assumed.
function realRunAnalysis(run) {
  const models = Object.entries(run.metrics).filter(([, m]) => m.r2 != null);
  if (models.length < 2) return null;
  const [best, other] = [...models].sort((a, b) => b[1].r2 - a[1].r2);
  const names = (m) => [m.mae != null && 'MAE', m.rmse != null && 'RMSE', 'R²'].filter(Boolean).join(', ');
  const mae = best[1].mae != null && other[1].mae != null ? `, MAE ${fmt(best[1].mae, 2)} vs ${fmt(other[1].mae, 2)}` : '';
  return {
    runId: run.id,
    runNumber: run.number,
    path: run.path,
    real: true,
    metrics: Object.fromEntries(models),
    checks: [
      `Ran ${run.path} to the end (exit code ${run.exitCode ?? 0}, ${seconds(run.durationMs)})`,
      `Recorded ${names(best[1])} for ${models.map(([n]) => n).join(' and ')}`,
      ...(run.figures.length ? [`Showed ${plural(run.figures.length, 'chart', 'charts')}`] : []),
    ],
    insight: `${best[0]} scores higher than ${other[0]} on this run: R² ${fmt(best[1].r2, 3)} vs ${fmt(other[1].r2, 3)}${mae}.`,
    nextSteps: [
      'Check the result with cross-validation, not only one train/test split.',
      `Look at where ${other[0]} misses most: plot its errors against the inputs.`,
    ],
  };
}

export function buildRunAnalysis(run) {
  if (run.status !== 'success' || !run.metrics) return null;
  if (run.real) return realRunAnalysis(run);
  const linear = run.metrics['Linear regression'];
  const tree = run.metrics['Decision tree'];
  if (!linear || !tree || linear.r2 == null || tree.r2 == null) return null;

  const linearWins = linear.r2 >= tree.r2;
  const [bestName, best, otherName, other] = linearWins
    ? ['Linear regression', linear, 'the decision tree', tree]
    : ['The decision tree', tree, 'linear regression', linear];
  const insight =
    `${bestName} fits this test set better than ${otherName}: R² ${fmt(best.r2, 3)} vs ${fmt(other.r2, 3)}, ` +
    `and its average error is $${fmt(best.mae, 1)}k vs $${fmt(other.mae, 1)}k.`;

  return {
    runId: run.id,
    runNumber: run.number,
    path: run.path,
    metrics: { 'Linear regression': linear, 'Decision tree': tree },
    checks: [
      'Trained linear regression and a decision tree',
      'Predicted prices for the 10 test homes',
      'Calculated MAE, RMSE and R² for each model',
      ...(run.figures.length > 1 ? ['Plotted predicted vs. actual prices'] : []),
    ],
    insight,
    nextSteps: [
      linearWins
        ? 'Tune the tree: try max_depth 2–3 or a larger min_samples_leaf. With 30 training homes, depth 4 can overfit.'
        : 'Check the linear model for missing features or non-linear effects.',
      'Use cross-validation. Ten test homes is a small sample.',
      'Add features such as location, if the data has them.',
    ],
  };
}
