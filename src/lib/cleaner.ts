import { toZonedTime, format } from "date-fns-tz";
import { DatasetMeta, Reading } from "../types";

interface Dataset {
  meta: any;
  readings: Reading[];
}

export interface CleanResult {
  meta: DatasetMeta & { cleaned: true };
  cleaned: Reading[];
  originalPrimary: Reading[];
  originalSecondary: Reading[];
  validation: {
    totalExpected: number;
    missing: number;
    invalid: number;
    backfilledFromSecondary: number;
    interpolated: number;
    forcedToZero: number;
    present: number;
  };
}

export function cleanPrimary(
  primary: Dataset,
  secondary: Dataset,
): CleanResult {
  const rating = primary.meta.system_rating_w;
  const timeZone = "Africa/Johannesburg";
  const startStr = primary.meta.period_start;
  const endStr = primary.meta.period_end;
  const intervalSec = primary.meta.interval_seconds;

  // 1. Generate correct local timestamps
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);
  const fullTimestamps: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    const zoned = toZonedTime(current, timeZone);
    fullTimestamps.push(
      format(zoned, "yyyy-MM-dd'T'HH:mm:ssXXX", { timeZone }),
    );
    current = new Date(current.getTime() + intervalSec * 1000);
  }

  // 2. Build primary map, detect duplicates
  const primaryMap = new Map<
    string,
    { value: number | null; duplicate: boolean }
  >();
  for (const r of primary.readings) {
    const ts = r.timestamp;
    if (primaryMap.has(ts)) {
      primaryMap.set(ts, { value: null, duplicate: true });
    } else {
      primaryMap.set(ts, { value: r.power_w, duplicate: false });
    }
  }

  // 3. Build secondary map (only numeric values)
  const secondaryMap = new Map<string, number>();
  for (const r of secondary.readings) {
    if (r.power_w !== null && r.power_w !== undefined) {
      secondaryMap.set(r.timestamp, r.power_w);
    }
  }

  // 4. Initial pass: completeness & plausibility
  const cleanedValues: (number | null)[] = [];
  let missingCount = 0;
  let invalidCount = 0;

  for (const ts of fullTimestamps) {
    const entry = primaryMap.get(ts);
    if (!entry) {
      missingCount++;
      cleanedValues.push(null);
      continue;
    }
    if (entry.duplicate) {
      invalidCount++;
      cleanedValues.push(null);
      continue;
    }
    let val = entry.value;
    if (val !== null && (val < 0 || val > rating)) {
      invalidCount++;
      val = null;
    }
    cleanedValues.push(val);
  }

  // 5. Outlier detection (spikes/dips) – marks more as invalid
  const outlierThreshold = 0.3 * rating;
  const windowSize = 5;
  for (let i = 0; i < cleanedValues.length; i++) {
    const val = cleanedValues[i];
    if (val === null) continue;

    const neighbors: number[] = [];
    for (
      let j = Math.max(0, i - windowSize);
      j <= Math.min(cleanedValues.length - 1, i + windowSize);
      j++
    ) {
      if (j === i) continue;
      if (cleanedValues[j] !== null) neighbors.push(cleanedValues[j]!);
    }
    if (neighbors.length < 2) continue;

    const sorted = [...neighbors].sort((a, b) => a - b);
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    if (Math.abs(val - median) > outlierThreshold) {
      invalidCount++;
      cleanedValues[i] = null;
    }
  }

  // 6. Backfill from secondary (only on exact 30‑min anchors)
  let backfilledCount = 0;
  for (let i = 0; i < cleanedValues.length; i++) {
    if (cleanedValues[i] !== null) continue;
    const ts = fullTimestamps[i];
    if (secondaryMap.has(ts)) {
      cleanedValues[i] = secondaryMap.get(ts)!;
      backfilledCount++;
    }
  }

  // 7. Linear interpolation for remaining nulls
  let interpolatedCount = 0;
  let startNull = -1;
  for (let i = 0; i < cleanedValues.length; i++) {
    if (cleanedValues[i] === null && startNull === -1) {
      startNull = i;
    } else if (cleanedValues[i] !== null && startNull !== -1) {
      const leftIdx = startNull - 1;
      const rightIdx = i;
      if (leftIdx >= 0 && rightIdx < cleanedValues.length) {
        const leftVal = cleanedValues[leftIdx];
        const rightVal = cleanedValues[rightIdx];
        if (leftVal !== null && rightVal !== null) {
          const leftTime = new Date(fullTimestamps[leftIdx]);
          const rightTime = new Date(fullTimestamps[rightIdx]);
          for (let k = startNull; k < i; k++) {
            const currentTime = new Date(fullTimestamps[k]);
            const fraction =
              (currentTime.getTime() - leftTime.getTime()) /
              (rightTime.getTime() - leftTime.getTime());
            cleanedValues[k] = leftVal + (rightVal - leftVal) * fraction;
            interpolatedCount++;
          }
        }
      }
      startNull = -1;
    }
  }

  // Edge nulls: fill with nearest neighbour (no interpolation possible)
  if (cleanedValues[0] === null) {
    let next = 1;
    while (next < cleanedValues.length && cleanedValues[next] === null) next++;
    if (next < cleanedValues.length) {
      for (let i = 0; i < next; i++) cleanedValues[i] = cleanedValues[next];
    }
  }
  if (cleanedValues[cleanedValues.length - 1] === null) {
    let prev = cleanedValues.length - 2;
    while (prev >= 0 && cleanedValues[prev] === null) prev--;
    if (prev >= 0) {
      for (let i = prev + 1; i < cleanedValues.length; i++)
        cleanedValues[i] = cleanedValues[prev];
    }
  }

  // 8. Build final cleaned readings, count forced‑to‑zero
  const cleanedReadings: Reading[] = [];
  let forcedToZero = 0;

  for (let i = 0; i < cleanedValues.length; i++) {
    const val = cleanedValues[i];
    if (val === null) {
      forcedToZero++;
      cleanedReadings.push({
        timestamp: fullTimestamps[i],
        power_w: 0,
      });
    } else {
      cleanedReadings.push({
        timestamp: fullTimestamps[i],
        power_w: Math.round(val * 10) / 10,
      });
    }
  }
  const totalExpected = fullTimestamps.length;
  const present = totalExpected - forcedToZero;

  return {
    meta: { ...primary.meta, cleaned: true },
    cleaned: cleanedReadings,
    originalPrimary: primary.readings,
    originalSecondary: secondary.readings,
    validation: {
      totalExpected,
      missing: missingCount,
      invalid: invalidCount,
      backfilledFromSecondary: backfilledCount,
      interpolated: interpolatedCount,
      forcedToZero,
      present,
    },
  };
}
