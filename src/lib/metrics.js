// Regression metrics, calculated the same way scikit-learn does.

export function meanAbsoluteError(actual, predicted) {
  const total = actual.reduce((sum, a, i) => sum + Math.abs(a - predicted[i]), 0);
  return total / actual.length;
}

export function rootMeanSquaredError(actual, predicted) {
  const total = actual.reduce((sum, a, i) => sum + (a - predicted[i]) ** 2, 0);
  return Math.sqrt(total / actual.length);
}

export function r2Score(actual, predicted) {
  const mean = actual.reduce((s, a) => s + a, 0) / actual.length;
  const residual = actual.reduce((s, a, i) => s + (a - predicted[i]) ** 2, 0);
  const totalVariance = actual.reduce((s, a) => s + (a - mean) ** 2, 0);
  return 1 - residual / totalVariance;
}

export function regressionMetrics(actual, predicted) {
  return {
    mae: meanAbsoluteError(actual, predicted),
    rmse: rootMeanSquaredError(actual, predicted),
    r2: r2Score(actual, predicted),
  };
}
