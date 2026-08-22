import { Reading } from "../../types";

interface Dataset {
  meta: any;
  readings: Reading[];
}

export interface CleanResult {
  meta: any;
  cleaned: Reading[];
  originalPrimary: Reading[];
  originalSecondary: Reading[];
  validation: {
    totalExpected: number;
    present: number;
    missing: number;
    invalid: number;
    backfilledFromSecondary: number;
    interpolated: number;
  };
}

export function cleanPrimary(
  primary: Dataset,
  secondary: Dataset,
): CleanResult {
  const rating = primary.meta.system_rating_w;
  const start = new Date(primary.meta.period_start);
  const end = new Date(primary.meta.period_end);
  const interval = primary.meta.interval_seconds; // 300

  // ----- 1. Build primary map; detect duplicate timestamps -----
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

  // ----- 2. Build secondary map (exact 30‑min anchors) -----
  const secondaryMap = new Map<string, number>();
  for (const r of secondary.readings) {
    if (r.power_w !== null && r.power_w !== undefined) {
      secondaryMap.set(r.timestamp, r.power_w);
    }
  }

  // ----- 3. Generate the full 5‑min timeline -----
  const fullTimestamps: string[] = [];
  let current = new Date(start);
  while (current <= end) {
    const iso = current.toISOString();
    const local = iso.replace(".000Z", "+02:00").replace(/\.\d{3}/, "");
    fullTimestamps.push(local);
    current = new Date(current.getTime() + interval * 1000);
  }

  const cleanedValues: (number | null)[] = [];
  let missingCount = 0;
  let invalidCount = 0;

  // ----- 4. Initial plausibility & completeness -----
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

  // ----- 5. Outlier detection (spikes / dips) -----
  const outlierThreshold = 0.3 * rating; // 720 W for a 2.4 kW system
  const windowSize = 5; // number of 5‑min steps left/right

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

  // ----- 6. Backfill gaps from secondary (exact 30‑min anchors) -----
  let backfilledCount = 0;
  for (let i = 0; i < cleanedValues.length; i++) {
    if (cleanedValues[i] !== null) continue;
    const ts = fullTimestamps[i];
    if (secondaryMap.has(ts)) {
      cleanedValues[i] = secondaryMap.get(ts)!;
      backfilledCount++;
    }
  }

  // ----- 7. Linear interpolation for remaining nulls -----
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

  // Handle edge nulls (fill with nearest value)
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

  // ----- 8. Build final cleaned readings (round to 1 decimal) -----
  const cleanedReadings: Reading[] = fullTimestamps.map((ts, i) => ({
    timestamp: ts,
    power_w:
      cleanedValues[i] !== null ? Math.round(cleanedValues[i]! * 10) / 10 : 0,
  }));

  const presentCount = cleanedReadings.filter((r) => r.power_w !== null).length;

  return {
    meta: { ...primary.meta, cleaned: true },
    cleaned: cleanedReadings,
    originalPrimary: primary.readings,
    originalSecondary: secondary.readings,
    validation: {
      totalExpected: fullTimestamps.length,
      present: presentCount,
      missing: missingCount,
      invalid: invalidCount,
      backfilledFromSecondary: backfilledCount,
      interpolated: interpolatedCount,
    },
  };
}
