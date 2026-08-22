"use client";

import { useEffect, useState } from "react";
import { Chart, ChartOptions, registerables } from "chart.js";
import { Line } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import { CleanResult } from "@/lib/cleaner";

Chart.register(...registerables);

export default function HomePage() {
  const [data, setData] = useState<CleanResult | null>(null);

  useEffect(() => {
    fetch("/api/clean")
      .then((res) => res.json())
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) return <div style={{ padding: "2rem" }}>Loading data…</div>;

  const chartData = {
    datasets: [
      {
        label: "Primary (original)",
        data: data.originalPrimary.map((r) => ({
          x: new Date(r.timestamp),
          y: r.power_w,
        })),
        borderColor: "rgba(255, 99, 132, 1)",
        backgroundColor: "rgba(255, 99, 132, 0.2)",
        pointRadius: 1,
        fill: false,
      },
      {
        label: "Secondary (30-min)",
        data: data.originalSecondary.map((r) => ({
          x: new Date(r.timestamp),
          y: r.power_w,
        })),
        borderColor: "rgba(54, 162, 235, 1)",
        backgroundColor: "rgba(54, 162, 235, 0.2)",
        pointRadius: 4,
        fill: false,
      },
      {
        label: "Cleaned final",
        data: data.cleaned.map((r) => ({
          x: new Date(r.timestamp),
          y: r.power_w,
        })),
        borderColor: "rgba(75, 192, 192, 1)",
        backgroundColor: "rgba(75, 192, 192, 0.2)",
        pointRadius: 1,
        fill: false,
      },
    ],
  };

  const options: ChartOptions<"line"> = {
    responsive: true,
    scales: {
      x: {
        type: "time",
        time: {
          unit: "hour",
          displayFormats: { hour: "HH:mm" },
        },
        title: { display: true, text: "Time" },
      },
      y: {
        beginAtZero: true,
        title: { display: true, text: "Power (W)" },
      },
    },
    plugins: {
      legend: { position: "top" },
      title: { display: true, text: "Solar Power Series" },
    },
  };
  const downloadCleaned = () => {
    const blob = new Blob([JSON.stringify(data.cleaned, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cleaned_solar_primary.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: "2rem" }}>
      <div style={{ height: "500px" }}>
        <Line data={chartData} options={options} />
      </div>
      <div style={{ marginTop: "2rem" }}>
        <h3>Validation Summary</h3>
        <ul>
          <li>Total expected readings: {data.validation.totalExpected}</li>
          <li>Present after cleaning: {data.validation.present}</li>
          <li>Missing originally: {data.validation.missing}</li>
          <li>Invalid values removed: {data.validation.invalid}</li>
          <li>
            Backfilled from secondary: {data.validation.backfilledFromSecondary}
          </li>
          <li>Interpolated: {data.validation.interpolated}</li>
        </ul>
        <button onClick={downloadCleaned}>
          Download cleaned series (JSON)
        </button>
      </div>
    </div>
  );
}
