export interface Reading {
  timestamp: string;
  power_w: number | null;
}

export interface DatasetMeta {
  site_id?: string;
  description?: string;
  source?: string;
  measurement?: string;
  unit?: string;
  interval_seconds: number;
  timezone?: string;
  period_start: string;
  period_end: string;
  system_rating_w: number;
  notes?: string;
  // Allow extra fields (e.g., "cleaned": true added later)
  [key: string]: unknown;
}

export interface Dataset {
  meta: DatasetMeta;
  readings: Reading[];
}
