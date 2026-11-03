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

export function buildRunAnalysis(run) {
  if (run.status !== 'success' || !run.metrics) return null;
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
