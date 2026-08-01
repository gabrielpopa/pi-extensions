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

const DASHBOARD_URL = "http://localhost:8181";

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

async function fetchGPUs(): Promise<GPUData[]> {
  try {
    const resp = await fetch(`${DASHBOARD_URL}/api/gpu`, { signal: AbortSignal.timeout(5000) });
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
  let vram = "VRAM:--";
  if (gpu["memory.used"] != null && gpu["memory.total"] != null && gpu["memory.total"] > 0) {
    const pct = ((gpu["memory.used"] / gpu["memory.total"]) * 100).toFixed(0);
    vram = `VRAM:${pct}%`;
  }
  return `${temp} ${util} ${vram}`;
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const REFRESH_MS = 3000;

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

    const widgetLines: string[] = [];
    for (const gpu of gpus) {
      if (gpu.error) {
        widgetLines.push(`  Error: ${gpu.error}`);
      } else {
        widgetLines.push(`  ${formatGPU(gpu)}`);
      }
    }

    const statusParts = gpus.map(compactGPU);
    const statusText = statusParts.join("  ●  ");

    if (ctx.mode === "tui") {
      ctx.ui.setWidget("gpu-status", widgetLines, { placement: "aboveEditor" });
      ctx.ui.setStatus("gpu-status", statusText);
    }
  }

  // ── Always visible, refreshing in background ────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      startRefresh(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    stopRefresh();
  });

  // ── /gpu-status command ──────────────────────────────────────────

  pi.registerCommand("gpu-status", {
    description: "Show current NVIDIA GPU status",
    handler: async (_args, ctx) => {
      const gpus = await fetchGPUs();

      if (gpus.length === 0) {
        ctx.ui.notify("GPU dashboard unreachable or no GPUs found", "warning");
        return;
      }

      const lines: string[] = [];
      for (const gpu of gpus) {
        if (gpu.error) {
          lines.push(`  Error: ${gpu.error}`);
        } else {
          lines.push(`  ${formatGPU(gpu)}`);
        }
      }

      ctx.ui.setWidget("gpu-status", lines, { placement: "aboveEditor" });
      ctx.ui.notify("GPU status updated", "info");
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
