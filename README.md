# Solar Data Cleaning Pipeline

A Next.js (App Router, TypeScript) application that validates, cleans, and backfills a 5-minute solar power series using a fault-free 30-minute reference series.

## Overview

The utility meter (`primary`) records power every 5 minutes but suffers from:

- **Missing readings** due to communication faults
- **Physically impossible values**, such as negative values or values above the system rating
- **Sudden spikes/dips** that are inconsistent with real solar behaviour

A secondary series from the inverter manufacturer (`secondary`) provides complete, reliable 30-minute data.

The pipeline:

1. **Validates** the primary for completeness, plausibility, and consistency.
2. **Removes** bad values using rule-based detection without hard-coded timestamps.
3. **Backfills** missing slots that align with the 30-minute anchors from the secondary.
4. **Interpolates** any remaining gaps linearly.
5. **Outputs** a cleaned 5-minute series and validation summary.

## Tech Stack

- **Next.js** (App Router, TypeScript)
- **Chart.js** (`react-chartjs-2` with `chartjs-adapter-date-fns`)
- **date-fns-tz** for correct timezone handling

## Installation

```bash
git clone <repository>
cd <project-folder>
npm install
```

Place the two input JSON files in the `data/` directory:

```text
data/
  solar_primary_5min.json
  solar_secondary_30min.json
```

The files must follow the structure provided in the problem statement, including `meta` and `readings` arrays.

The primary dataset should have:

```text
interval_seconds: 300
```

The secondary dataset should have:

```text
interval_seconds: 1800
```

## Running the App

Start the development server:

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

The page will:

- Automatically fetch the cleaned data through the API.
- Display three series on a Chart.js time-series graph:
  - **Red:** Original primary data with faults
  - **Blue:** Secondary 30-minute reference data
  - **Green:** Final cleaned 5-minute series

- Show a validation summary containing counts of missing, invalid, backfilled, interpolated, and forced-to-zero readings.
- Provide a **Download** button to save the cleaned series as a JSON file.

## How It Works

### 1. Completeness Check

Every expected 5-minute slot between `period_start` and `period_end` is generated using the correct timezone (`Africa/Johannesburg`).

Any timestamp missing from the primary dataset is marked as missing.

### 2. Plausibility Check

Readings outside the valid range are discarded:

```text
0 <= power_w <= 2400
```

The `2400 W` limit is based on the system rating.

### 3. Duplicate Detection

If the same timestamp appears more than once in the primary dataset, all entries for that timestamp are treated as invalid and removed.

### 4. Outlier Detection

For each value, a median of up to five neighbouring values on the left and right is calculated.

If the absolute deviation from the median exceeds:

```text
0.3 × system_rating_w
```

the point is considered an outlier and removed.

For a `2400 W` system:

```text
0.3 × 2400 = 720 W
```

Therefore, deviations greater than `720 W` are treated as outliers.

### 5. Backfill from Secondary

Any null slot whose timestamp exactly matches a 30-minute secondary reading is filled with the corresponding secondary value.

These timestamps act as anchor points from the trusted secondary dataset.

### 6. Linear Interpolation

Remaining null runs are filled using linear interpolation between the nearest surrounding valid values.

Edge gaps at the beginning or end of the series are filled using the nearest valid neighbour.

### 7. Forced-to-Zero

If any null values remain after all previous steps, they are set to `0`.

These points are counted separately as `forcedToZero` and are **not** counted as `present`.

## API Endpoint

### `GET /api/clean`

Returns a JSON object containing:

- `meta`: Original metadata with `cleaned: true`
- `cleaned`: Final cleaned 5-minute series
- `originalPrimary`: Raw primary readings
- `originalSecondary`: Raw secondary readings
- `validation`: Validation summary statistics

The API also writes the cleaned series to:

```text
data/cleaned_solar_primary.json
```

The file is overwritten on every API call.

## Validation Summary

| Field                     | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `totalExpected`           | Total number of expected 5-minute slots in the period                        |
| `present`                 | Slots containing a real value, including legitimate zero readings            |
| `missing`                 | Slots that were originally absent from the primary data                      |
| `invalid`                 | Readings removed because of duplicates, out-of-range values, or outliers     |
| `backfilledFromSecondary` | Slots filled from the 30-minute secondary dataset at exact anchor timestamps |
| `interpolated`            | Slots filled using linear interpolation                                      |
| `forcedToZero`            | Unresolved gaps set to `0` after all other cleaning steps                    |

### Important Validation Behaviour

`present` and `forcedToZero` are tracked separately.

A legitimate `0 W` reading is considered **present** because it is a real value.

A reading that remained unresolved and had to be forced to `0` is counted under **`forcedToZero`**, not `present`.

This prevents the validation summary from confusing genuine zero-power readings with unresolved missing data.

## Output File

The cleaned series is saved as:

```text
data/cleaned_solar_primary.json
```

Each entry contains:

```json
{
  "timestamp": "...",
  "power_w": 123.4
}
```

Power values are rounded to one decimal place.

The file is overwritten on every API call.

## Notes

- All detection rules are **general** and do not depend on hard-coded timestamps or indices.
- Every output value can be traced to one of the pipeline steps: validation, backfill, interpolation, or forced zero.
- The secondary 30-minute dataset is treated as complete, fault-free, and trusted for validation and backfilling.
- Timestamp matching for backfilling uses the 30-minute secondary anchors.
- Timezone handling preserves Johannesburg local time (`+02:00`).
- The pipeline produces a complete 5-minute output series for the requested period.

## Review Notes

- toISOString() returns the time in UTC. The code then labels that timestamp as +02:00 without actually adjusting the time. That makes the timestamp wrong by 2 hours. Because the dataset is dense, it can still match another real reading, so this may not show up as a missing timestamp. It can just quietly point to the wrong reading.
- If entry.value is null, the validation check is skipped because of the val !== null condition. This means the null value isn't counted as missing or invalid.
- Values that are still null after all the fill steps are eventually changed to 0. They're then included in the present count, even though they weren't actually present in the source data.
- There isn't any type validation for the main input values such as rating, interval, and the period start/end dates. These values are used throughout the pipeline, so invalid input could cause unexpected results.
- If /api/clean fails, the page only logs the error to the console. The UI stays on Loading data… indefinitely, so the user has no idea that something went wrong.
- In page.tsx, add an error state and set it when the fetch fails. The page should show the error instead of staying on Loading data.
- The cleaned series should be saved under the data folder. If the file already exists, overwrite it with the new cleaned data.

## My assumptions

- I assumed the data is using Africa/Johannesburg (+02:00). There is no DST currently, so using a fixed offset works for this dataset. However, the offset should ideally be taken from period_start rather than hardcoded, in case data from other sites or timezones is added later.
- For duplicate timestamps in the primary series, I treated both readings as invalid and discarded them because there isn't enough information to know which one is correct. This also matches the behavior of the original code.
- I treated the secondary 30-minute series as the trusted source for the exact 30-minute timestamps, based on the metadata stating that it is complete and has no known faults.

## What I'd do with more time

- Check the Jan 2 04:20–06:15 gap against weather data before relying on a straight-line interpolation. The gap is around sunrise, so the actual solar ramp-up probably isn't linear.
- Add some small unit tests for each helper once cleaner.ts is split up as mentioned in item 5. I'd especially test the timestamp formatting and interpolation, so an issue like the one in item 1 gets caught automatically.
- Review the outlier threshold from item 6 using a few known cloudy days. This would help confirm that we're not treating normal changes caused by cloud cover as sensor noise.

## What your pipeline changed, as counts

These are the actual counts after accounting for the timestamp issue in item 1. I worked them out from the raw JSON rather than relying on the original `validation` output, since that output was affected by the timestamp bug.

| Category                                                                       | Count |
| ------------------------------------------------------------------------------ | ----: |
| Total expected slots (5-min, Jan 1–2)                                          |   576 |
| Missing from source entirely (2 gaps: Jan 1 13:00–14:35 and Jan 2 04:20–06:15) |    44 |
| Duplicate timestamp, both readings dropped                                     |     1 |
| Explicit `null` reading in source                                              |     1 |
| Out-of-range reading (one 4871.6 W spike vs. 2400 W rating)                    |     1 |
| Flagged as outlier vs. local median                                            |     4 |
| Backfilled from secondary 30-min series                                        |    10 |
| Interpolated (linear, between nearest known points)                            |    41 |
| Edge-filled (series start/end)                                                 |     0 |

### Rules I chose for step 1, mapped to the three checks in the spec

The spec separates validation into three checks. The original code only really implements one of them directly. The other two are partly covered by side effects rather than being clearly defined rules.

**Completeness: "Is every expected 5-minute slot present?"**

- **Rule used:** Generate every timestamp from `period_start` to `period_end` using `interval_seconds`, then check which timestamps don't have a matching entry in the primary file.
- **Result:** 44 slots are completely missing, across two gaps: 13:00–14:35 on Jan 1 and 04:20–06:15 on Jan 2.
- The approach itself was correct, but the timestamp bug in item #1 caused the generated timestamps to be misaligned with the actual data.

**Plausibility: "Is every value physically possible for this system?"**

- **Rule used:** A value is considered invalid if it's below 0 or above `system_rating_w` (2400 W).
- **Result:** 1 reading was caught: 4871.6 W, which is roughly twice the rated capacity.
- This rule works for basic range checking, but it isn't enough on its own to cover all plausibility issues.

**Consistency: "Does the data behave sensibly from one reading to the next and follow the day/night pattern?"**

- This is the part the original code doesn't really implement as a defined rule.
- There is an outlier check that flags values more than 30% of the system rating away from the median of the surrounding ±25 minutes. That's useful for detecting sudden spikes, but it doesn't actually understand the day/night cycle. It doesn't know whether a reading happened during daylight or at night.
- For example, there is a reading of **1648.2 W at 02:30 on Jan 2**. It's within the valid 0–2400 W range, so the basic plausibility check accepts it. It only gets removed because the surrounding readings are 0 and the outlier check happens to catch it.
- That's more luck than an intentional validation rule. If several bad readings occurred around 02:30, the median check could potentially miss them even though significant solar output at that time should clearly be suspicious.

**Rule I'd add:** explicitly check whether a reading falls within the expected daylight period. Any meaningful output outside that window should be flagged, regardless of the neighboring values. The daylight window could come from the secondary series' day/night pattern, or from a solar-elevation calculation if the site's latitude and longitude are available.

That would give the pipeline a proper day/night consistency check instead of relying on the outlier filter to catch these cases indirectly.
