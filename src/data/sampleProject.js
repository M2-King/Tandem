// The sample project that Tandem opens with.
//
// Besides the starting files, this module also holds the *known versions*
// of each file (for example main.py after the assistant's change). The mock
// AI and execution services use these to recognise which code they are
// looking at. A real backend would not need this.

export const HOUSING_CSV = `size_sqft,bedrooms,age_years,price_k
2680,3,27,479
2010,3,38,355
2130,2,33,396
2580,4,40,465
1910,3,57,312
2320,3,9,422
2450,2,34,433
1170,1,26,207
810,1,22,215
1330,2,15,304
1290,1,4,278
2530,3,24,500
2610,3,49,435
710,1,6,220
1740,3,24,344
2420,3,58,425
970,1,57,92
2370,4,13,491
950,1,1,163
1680,2,40,220
2410,4,1,492
1330,2,18,240
1410,1,30,263
1280,2,52,297
2210,4,6,431
1230,1,40,187
2770,4,32,522
1630,2,8,359
1700,2,50,278
1750,4,50,309
1920,3,29,393
1860,2,56,321
1760,3,36,290
2790,4,54,479
2390,3,57,400
2360,4,34,403
2170,3,17,437
2000,3,9,379
1410,3,34,311
2770,4,12,553
`;

const MAIN_IMPORTS = `"""Predict house prices from size, bedrooms, and age."""

import pandas as pd
import matplotlib.pyplot as plt
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import train_test_split
`;

const MAIN_CORE = `
# Load the sample dataset
df = pd.read_csv("data/housing.csv")
print(f"Loaded {len(df)} homes with columns: {', '.join(df.columns)}")

features = ["size_sqft", "bedrooms", "age_years"]
X = df[features]
y = df["price_k"]

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.25, random_state=42
)

# Train a linear regression model
model = LinearRegression()
model.fit(X_train, y_train)
print(f"Trained on {len(X_train)} homes, testing on {len(X_test)}")

for name, coef in zip(features, model.coef_):
    print(f"  {name:>10}: {coef:+.2f}")
`;

const MAIN_EXPLORE_PLOT = `
# Explore the relationship between size and price
plt.scatter(df["size_sqft"], df["price_k"])
plt.xlabel("Size (sq ft)")
plt.ylabel("Price ($k)")
plt.title("Price vs. size")
plt.show()
`;

// Starting version of main.py.
export const MAIN_BASELINE =
  MAIN_IMPORTS +
  MAIN_CORE +
  `
print(f"Test R²: {model.score(X_test, y_test):.3f}")
` +
  MAIN_EXPLORE_PLOT;

const COMPARE_IMPORTS = `"""Predict house prices from size, bedrooms, and age."""

import pandas as pd
import matplotlib.pyplot as plt
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeRegressor
`;

const COMPARE_MODELS = `
# Train a decision tree for comparison
tree = DecisionTreeRegressor(max_depth=4, random_state=42)
tree.fit(X_train, y_train)

# Predict prices for the test homes
linear_pred = model.predict(X_test)
tree_pred = tree.predict(X_test)

print()
print("Model comparison on test data")
for name, pred in [("Linear regression", linear_pred), ("Decision tree", tree_pred)]:
    mae = mean_absolute_error(y_test, pred)
    rmse = mean_squared_error(y_test, pred) ** 0.5
    r2 = r2_score(y_test, pred)
    print(f"  {name:<18} MAE {mae:5.1f}  RMSE {rmse:5.1f}  R² {r2:.3f}")
`;

// main.py after the demo request:
// "Add predictions for the test data, plot predicted versus actual values,
//  and compare the model with a decision tree."
export const MAIN_COMPARE =
  COMPARE_IMPORTS +
  MAIN_CORE +
  COMPARE_MODELS +
  MAIN_EXPLORE_PLOT +
  `
# Plot predicted versus actual prices for each model
fig, axes = plt.subplots(1, 2, figsize=(10, 4), sharey=True)
models = [("Linear regression", linear_pred), ("Decision tree", tree_pred)]
for ax, (name, pred) in zip(axes, models):
    ax.scatter(y_test, pred)
    ax.plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], "--", color="gray")
    ax.set_title(name)
    ax.set_xlabel("Actual price ($k)")
axes[0].set_ylabel("Predicted price ($k)")
plt.tight_layout()
plt.show()
`;

// main.py after the chart follow-up: "Show both models in the same chart."
export const MAIN_COMBINED =
  COMPARE_IMPORTS +
  MAIN_CORE +
  COMPARE_MODELS +
  MAIN_EXPLORE_PLOT +
  `
# Plot predicted versus actual prices for both models
low, high = y_test.min(), y_test.max()
plt.figure(figsize=(6, 5))
plt.scatter(y_test, linear_pred, marker="o", label="Linear regression")
plt.scatter(y_test, tree_pred, marker="s", label="Decision tree")
plt.plot([low, high], [low, high], "--", color="gray", label="Perfect prediction")
plt.xlabel("Actual price ($k)")
plt.ylabel("Predicted price ($k)")
plt.title("Predicted vs. actual price")
plt.legend()
plt.show()
`;

// summary.py ships with a bug (wrong column name) so the demo has a
// realistic error to run into and fix.
export const SUMMARY_BUG = `"""Summarize prices by number of bedrooms."""

import pandas as pd

df = pd.read_csv("data/housing.csv")

summary = df.groupby("bedrooms")["price"].agg(["count", "mean"])
summary["mean"] = summary["mean"].round(1)

print("Average price by bedrooms ($k)")
print(summary.to_string())
`;

export const SUMMARY_FIXED = SUMMARY_BUG.replace(
  'df.groupby("bedrooms")["price"]',
  'df.groupby("bedrooms")["price_k"]'
);

// A tiny script for Step through and Debug. The predefined trace in
// services/traceService.js mirrors this code line by line.
export const PRICE_STATS = `"""Find the average price and the prices above it."""

prices = [310, 425, 280, 515]


def average(values):
    total = 0
    for value in values:
        total = total + value
    return total / len(values)


mean_price = average(prices)
above_mean = []
for price in prices:
    if price > mean_price:
        above_mean.append(price)

print(f"Mean price: {mean_price}")
print(f"Above mean: {above_mean}")
`;

export const PROJECT_NAME = 'house-prices';

// File paths in display order. Folders are derived from the paths.
export const SAMPLE_FILES = {
  'main.py': MAIN_BASELINE,
  'summary.py': SUMMARY_BUG,
  'price_stats.py': PRICE_STATS,
  'data/housing.csv': HOUSING_CSV,
};

export const FILE_ORDER = ['main.py', 'summary.py', 'price_stats.py', 'data/housing.csv'];

export const DEBUG_FILE = 'price_stats.py';

// Breakpoints the demo starts with (line numbers in price_stats.py).
export const DEFAULT_BREAKPOINTS = { 'price_stats.py': [16] };
