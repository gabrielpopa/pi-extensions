/**
 * GPU Status Extension
 *
 * Shows NVIDIA GPU card details in the pi TUI during inference.
 * Fetches data from the local GPU dashboard API (http://localhost:8181).
 *
 * Features:
 * - Widget above editor showing GPU stats during agent runs
 * - Footer status line with compact GPU summary
 * - /gpu-status command for on-demand checks
 * - gpu_status tool callable by the LLM
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface GPUData {
  index: number | null;
  name: string | null;
  "temperature.gpu": number | null;
  "utilization.gpu": number | null;
  "utilization.memory": number | null;
  "memory.used": number | null;
  "memory.total": number | null;
  "power.draw": number | null;
  "enforced.power.limit": number | null;
  "clocks.current.graphics": number | null;
  "clocks.current.memory": number | null;
  "fan.speed": number | null;
  error?: string;
}

const DASHBOARD_URL = process.env.PI_GPU_DASHBOARD_URL ?? "http://localhost:8181";

async function fetchGPUs(): Promise<GPUData[]> {
  try {
    // ?sid=gpu-ext registers us as a viewer so the dashboard keeps refreshing
    const resp = await fetch(`${DASHBOARD_URL}/api/gpu?sid=gpu-ext`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    return (await resp.json()) as GPUData[];
  } catch {
    return [];
  }
}

function makeBar(percent: number, width: number = 10): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatGPU(gpu: GPUData): string {
  const name = gpu.name ?? "Unknown";
  const temp = gpu["temperature.gpu"] != null ? `${gpu["temperature.gpu"]}°C` : "--";
  const util = gpu["utilization.gpu"] != null ? `${gpu["utilization.gpu"]}%` : "--";
  const power = gpu["power.draw"] != null ? `${gpu["power.draw"]}W` : "--";
  const fan = gpu["fan.speed"] != null ? `${gpu["fan.speed"]}%` : "--";

  let vram = "--";
  if (gpu["memory.used"] != null && gpu["memory.total"] != null && gpu["memory.total"] > 0) {
    const used = (gpu["memory.used"] / 1024).toFixed(1);
    const total = (gpu["memory.total"] / 1024).toFixed(1);
    const pct = ((gpu["memory.used"] / gpu["memory.total"]) * 100).toFixed(0);
    vram = `${used}/${total} ${makeBar(Number(pct))} ${pct}%`;
  }

  return `${name} | ${temp} | GPU:${util} | ${vram} | ${power} | Fan:${fan}`;
}

function compactGPU(gpu: GPUData): string {
  const temp = gpu["temperature.gpu"] != null ? `${gpu["temperature.gpu"]}°C` : "--";
  const util = gpu["utilization.gpu"] != null ? `GPU:${gpu["utilization.gpu"]}%` : "GPU:--";
  let vram = "--";
  if (gpu["memory.used"] != null && gpu["memory.total"] != null && gpu["memory.total"] > 0) {
    const pct = ((gpu["memory.used"] / gpu["memory.total"]) * 100).toFixed(0);
    vram = `${pct}%`;
  }
  return `${temp} ${util} ${vram}`;
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const REFRESH_MS = 3000;
  let widgetVisible = true;
  let firstAgentRunDone = false;

  // ── Start / stop periodic refresh ────────────────────────────────

  function startRefresh(ctx: Parameters<NonNullable<Parameters<typeof pi.on>[1]>>[1]) {
    if (refreshTimer) return;
    refreshGPUs(ctx);
    refreshTimer = setInterval(() => refreshGPUs(ctx), REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // ── Fetch and render ─────────────────────────────────────────────

  async function refreshGPUs(ctx: Parameters<NonNullable<Parameters<typeof pi.on>[1]>>[1]) {
    const gpus = await fetchGPUs();
    if (gpus.length === 0) return;

    // Group by metric: Temp, GPU util, VRAM util
    const temps = gpus.map(g => g["temperature.gpu"] != null ? `${g["temperature.gpu"]}°C` : "--");
    const utils = gpus.map(g => g["utilization.gpu"] != null ? `${g["utilization.gpu"]}%` : "--");
    const vrams = gpus.map(g => {
      if (g["memory.used"] != null && g["memory.total"] != null && g["memory.total"] > 0) {
        return `${((g["memory.used"] / g["memory.total"]) * 100).toFixed(0)}%`;
      }
      return "--";
    });
    const statusText = `Temp: ${temps.join("/")}  GPU: ${utils.join("/")}  VRAM: ${vrams.join("/")}`;

    if (ctx.mode === "tui") {
      // Always show footer
      ctx.ui.setStatus("gpu-status", statusText);

      // Widget respects toggle state
      if (widgetVisible) {
        const widgetLines: string[] = [];
        for (const gpu of gpus) {
          if (gpu.error) {
            widgetLines.push(`  Error: ${gpu.error}`);
          } else {
            widgetLines.push(`  ${formatGPU(gpu)}`);
          }
        }
        ctx.ui.setWidget("gpu-status", widgetLines, { placement: "aboveEditor" });
      } else {
        ctx.ui.setWidget("gpu-status", undefined);
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      startRefresh(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopRefresh();
  });

  pi.on("agent_start", async () => {
    if (!firstAgentRunDone) {
      firstAgentRunDone = true;
      widgetVisible = false;
    }
  });

  // ── /gpu-toggle command ──────────────────────────────────────────

  pi.registerCommand("gpu-toggle", {
    description: "Toggle GPU widget visibility (on/off)",
    handler: async (_args, ctx) => {
      widgetVisible = !widgetVisible;
      if (widgetVisible) {
        ctx.ui.notify("GPU widget enabled", "info");
      } else {
        ctx.ui.setWidget("gpu-status", undefined);
        ctx.ui.notify("GPU widget disabled", "info");
      }
    },
  });

  // ── gpu_status tool (LLM can call) ───────────────────────────────

  pi.registerTool({
    name: "gpu_status",
    label: "GPU Status",
    description:
      "Query NVIDIA GPU cards status from the local dashboard. Returns temperature, utilization, VRAM usage, power draw, and fan speed.",
    promptSnippet: "Check NVIDIA GPU status, temperatures, VRAM, and power draw",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const gpus = await fetchGPUs();

      if (gpus.length === 0) {
        return {
          content: [{ type: "text", text: "GPU dashboard is unreachable or no GPUs found." }],
          details: {},
        };
      }

      const lines: string[] = [];
      for (const gpu of gpus) {
        if (gpu.error) {
          lines.push(`  Error: ${gpu.error}`);
        } else {
          lines.push(`  ${formatGPU(gpu)}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { gpus },
      };
    },
  });
}
