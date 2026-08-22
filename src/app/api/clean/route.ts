import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import primaryData from "@/data/solar_primary_5min.json";
import secondaryData from "@/data/solar_secondary_30min.json";
import { cleanPrimary } from "@/lib/cleaner";

export async function GET() {
  // 1. Clean the data
  const result = cleanPrimary(primaryData, secondaryData);

  // 2. Ensure the data directory exists
  const dataDir = path.join(process.cwd(), "src/data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 3. Write the cleaned series to a file (override if exists)
  const filePath = path.join(dataDir, "cleaned_solar_primary.json");
  fs.writeFileSync(filePath, JSON.stringify(result.cleaned, null, 2), "utf-8");

  // 4. Return the full result for the frontend
  return NextResponse.json(result);
}
