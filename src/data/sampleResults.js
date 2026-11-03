// Fixed sample results for the house-prices project.
//
// These numbers were produced once by running the sample code with
// scikit-learn (train_test_split with random_state=42, a 10-home test set).
// Every metric the prototype shows is calculated from these arrays by
// lib/metrics.js, so the charts, printed output, and metrics always agree.

import { HOUSING_CSV } from './sampleProject.js';

// Actual prices (in $k) of the 10 test homes, in test-set order.
export const TEST_ACTUAL = [220, 92, 425, 522, 312, 435, 379, 359, 553, 433];

// Predictions for the same homes.
export const LINEAR_PRED = [304.8, 168.1, 408.7, 501.6, 334.2, 446.5, 398.5, 331.4, 522.8, 425.3];
export const TREE_PRED = [276.7, 214.0, 400.0, 474.3, 355.0, 474.3, 434.0, 276.7, 474.3, 494.3];

export const LINEAR_COEFFICIENTS = {
  size_sqft: 0.148,
  bedrooms: 13.362,
  age_years: -1.062,
};

export const TRAIN_COUNT = 30;
export const TEST_COUNT = TEST_ACTUAL.length;

// Parse the original CSV once so charts and summaries use the same rows.
export function parseHousing(csvText = HOUSING_CSV) {
  const [header, ...lines] = csvText.trim().split('\n');
  const columns = header.split(',');
  const rows = lines.map((line) => {
    const values = line.split(',').map(Number);
    return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
  });
  return { columns, rows };
}
