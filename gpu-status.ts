/**
 * GPU Status Extension
 *
 * Shows NVIDIA GPU stats in the footer only (no widget above editor).
 * Fetches data from the local GPU dashboard API.
 *
 * Features:
 * - Compact footer summary by default
 * - /gpu-toggle switches to detailed per-GPU footer view
 * - gpu_status tool callable by the LLM
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const DASHBOARD_URL = process.env.PI_GPU_DASHBOARD_URL ?? "http://192.168.1.10:8181";

async function fetchGPUs(): Promise<GPUData[]> {
  try {
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

function compactGPUName(name: string | null): string {
  if (!name) return "?";
  // Extract model number (e.g. "RTX 3090" -> "3090", "GeForce RTX 4070 Ti" -> "4070")
  const match = name.match(/\d{4}/);
  return match ? match[0] : name;
}

function colorUtil(utilPct: number | null, theme?: ExtensionContext["ui"]["theme"]): string {
  if (utilPct == null) return "--";
  const str = `${utilPct}%`;
  return utilPct > 0 && theme ? theme.fg("success", str) : str;
}

function formatGPU(gpu: GPUData, theme?: ExtensionContext["ui"]["theme"]): string {
  const name = compactGPUName(gpu.name);
  const temp = gpu["temperature.gpu"] != null ? `${gpu["temperature.gpu"]}°C` : "--";
  const util = colorUtil(gpu["utilization.gpu"], theme);
  const power = gpu["power.draw"] != null ? `${Math.round(gpu["power.draw"])}W` : "--";
  const fan = gpu["fan.speed"] != null ? `${gpu["fan.speed"]}%` : "--";

  let vram = "--";
  if (gpu["memory.used"] != null && gpu["memory.total"] != null && gpu["memory.total"] > 0) {
    const used = (gpu["memory.used"] / 1024).toFixed(1);
    const total = (gpu["memory.total"] / 1024).toFixed(1);
    const pct = ((gpu["memory.used"] / gpu["memory.total"]) * 100).toFixed(0);
    vram = `${used}/${total} ${makeBar(Number(pct))} ${pct}%`;
  }

  return `${name} ${temp} ${util} ${vram} ${power} Fan:${fan}`;
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const REFRESH_MS = 3000;
  let detailedFooter = false; // compact by default, toggle to detailed

  function startRefresh(ctx: ExtensionContext) {
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

  async function refreshGPUs(ctx: ExtensionContext) {
    try {
      const gpus = await fetchGPUs();
      if (gpus.length === 0 || ctx.mode !== "tui") return;

      if (detailedFooter) {
        // Detailed: full per-GPU info in the footer
        const lines: string[] = [];
        for (const gpu of gpus) {
          if (gpu.error) {
            lines.push(`Error: ${gpu.error}`);
          } else {
            lines.push(formatGPU(gpu, ctx.ui.theme));
          }
        }
        ctx.ui.setStatus("gpu-status", lines.join(" ◆ "));
      } else {
        // Compact: single-line summary
        const temps = gpus.map(
          (g) => g["temperature.gpu"] != null ? `${g["temperature.gpu"]}°C` : "--",
        );
        const utils = gpus.map((g) => colorUtil(g["utilization.gpu"], ctx.ui.theme));
        const vrams = gpus.map((g) => {
          if (g["memory.used"] != null && g["memory.total"] != null && g["memory.total"] > 0) {
            return `${((g["memory.used"] / g["memory.total"]) * 100).toFixed(0)}%`;
          }
          return "--";
        });
        ctx.ui.setStatus("gpu-status", `Temp: ${temps.join("/")}  GPU: ${utils.join("/")}  VRAM: ${vrams.join("/")}`);
      }
    } catch {
      // Silently swallow errors from stale context or UI failures.
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

  // ── /gpu-toggle command ──────────────────────────────────────────

  pi.registerCommand("gpu-toggle", {
    description: "Toggle GPU footer between compact and detailed view",
    handler: async (_args, ctx) => {
      detailedFooter = !detailedFooter;
      ctx.ui.notify(detailedFooter ? "GPU detailed" : "GPU compact", "info");
      refreshGPUs(ctx);
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
