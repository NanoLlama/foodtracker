# Food Tracker

A browser-based food and calorie tracker for staying in a consistent calorie deficit. Plain HTML, CSS and vanilla JavaScript, with no build step and no dependencies.

## Running it

Double-click `index.html`, or serve the folder locally:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

All data is stored in this browser's `localStorage` under the key `foodTracker.v1`. Use **Settings → Backup** to export it regularly.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell and bottom/top navigation |
| `styles.css` | Responsive layout, light/dark theme (follows the system setting) |
| `app.js` | All app logic: storage, nutrition math, views, online lookup |
| `tests.html` | Open in a browser to run the calculation and acceptance tests (does not touch saved data) |

## How the numbers work

- Foods store nutrition **per 100 g**. An entry's nutrition is `per100g × grams / 100`.
- Every amount is converted to and stored as grams (1 oz = 28.3495 g; named servings use their gram weight).
- Values are stored unrounded. Calories are rounded to whole numbers and macros to 1 decimal **only for display**, and totals are summed from unrounded values and rounded once at the end. A total can therefore differ by 1 from the sum of the rounded rows shown above it.
- Each log entry keeps a **snapshot** of the food's nutrition, so editing or deleting a library food never changes past days.
- **Target**: BMR (Mifflin-St Jeor) × activity multiplier − deficit, or a manual override. Exercise does not add calories back. The target in effect on each date is recorded, so History compares each day against the target that applied then.
- **Recipes**: the ingredient totals are divided by the total cooked weight (or by the raw total when no cooked weight is given) to get per-100 g values for the finished dish.
- **History averages** count only days with at least one entry, and exclude today unless "Include today" is checked. "Avg deficit" is your current TDEE minus average intake.

## Online lookup

- **Open Food Facts** (no key needed): text search, or type a barcode number (8–14 digits).
- **USDA FoodData Central**: paste a free API key in Settings to enable it. It is hidden when no key is set.

Results are normalized to per-100 g values. Any missing calorie or macro value is flagged and must be filled in before saving; missing values are never treated as 0. If the network fails, the app offers manual entry instead.

## Data format

```js
{
  schemaVersion: 1,
  settings: { units, profile: { sex, age, heightCm, weightKg, activityLevel }, deficit,
              targetMode, manualTarget, macroTargets, usdaApiKey, lastBackup },
  foods: [{ id, name, brand, source, sourceId, per100g, servings, recipe, createdAt, updatedAt }],
  logs: { "YYYY-MM-DD": [{ id, meal, foodId, name, brand, grams, unitLabel, unitQty,
                           per100g, servings, nutrition, createdAt }] },
  weights: [{ date, kg }],
  targetHistory: [{ from: "YYYY-MM-DD", kcal }]
}
```

Import validates the file first, then offers **Replace all** (restores the backup exactly) or **Merge** (adds foods and log entries by ID and weights by date, and keeps your current settings). Future schema changes go in `MIGRATIONS` in `app.js`.
