/**
 * GPU Status Extension
 *
 * Shows NVIDIA GPU stats in the footer only (no widget above editor).
 * Fetches data from the local GPU dashboard API.
 *
 * Features:
 * - Compact footer summary
 * - /gpu-status shows a detailed per-GPU table in the main window
 * - /gpu-server lists, adds, switches and removes dashboard servers (multiple supported)
 * - gpu_status tool callable by the LLM
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
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

// Server list lives next to the other agent config so it survives restarts and is shared
// by the footer, /gpu-status and the gpu_status tool.
const CONFIG_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "gpu-servers.json");

interface Server {
  name: string;
  url: string;
}

interface Config {
  servers: Server[];
  active: string;
}

// Accepts "192.168.1.42:8181" or "http://host:8181/" and always yields a base URL.
function normalizeUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(url) ? url : `http://${url}`;
}

function loadConfig(): Config {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
    if (Array.isArray(cfg.servers) && cfg.servers.length > 0) return cfg;
  } catch {
    // missing or corrupt file falls through to the seed below
  }
  const url = normalizeUrl(process.env.PI_GPU_DASHBOARD_URL ?? "http://192.168.1.10:8181");
  return { servers: [{ name: "default", url }], active: "default" };
}

function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function activeServer(cfg: Config): Server {
  return cfg.servers.find((s) => s.name === cfg.active) ?? cfg.servers[0];
}

async function fetchFrom(url: string): Promise<GPUData[]> {
  try {
    const resp = await fetch(`${url}/api/gpu?sid=gpu-ext`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    return (await resp.json()) as GPUData[];
  } catch {
    return [];
  }
}

async function fetchGPUs(): Promise<GPUData[]> {
  return fetchFrom(activeServer(loadConfig()).url);
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
  const str = `${utilPct}`;
  return utilPct > 0 && theme ? theme.fg("success", str) : str;
}

// Threshold colors: >=40 uses the theme's success tint (same as GPU util),
// higher tiers use fixed ANSI 256 (theme palette has no orange).
function colorTemp(temp: number | null, theme?: ExtensionContext["ui"]["theme"]): string {
  if (temp == null) return "--";
  const text = `${temp}`;
  if (temp >= 70) return `\x1b[38;5;196m${text}\x1b[39m`;
  if (temp >= 60) return `\x1b[38;5;208m${text}\x1b[39m`;
  if (temp >= 40) return theme ? theme.fg("success", text) : `\x1b[38;5;226m${text}\x1b[39m`;
  // Soft muted green (#5faf5f), easy on the eyes
  return `\x1b[38;5;64m${text}\x1b[39m`;
}

// VRAM usage tiers: >=90 red, >=80 orange, >=10 yellow, >=1 green, 0 normal.
function colorVramPct(pct: number, theme?: ExtensionContext["ui"]["theme"]): string {
  const text = `${pct}`;
  // Theme error red is softer and adapts to dark/light (#cc6666 / #aa5555)
  if (pct >= 90) return theme ? theme.fg("error", text) : `\x1b[38;5;196m${text}\x1b[39m`;
  if (pct >= 80) return `\x1b[38;5;208m${text}\x1b[39m`;
  if (pct >= 10) return theme ? theme.fg("success", text) : `\x1b[38;5;226m${text}\x1b[39m`;
  if (pct >= 1) return `\x1b[38;5;64m${text}\x1b[39m`;
  return text;
}

function formatGPU(gpu: GPUData, theme?: ExtensionContext["ui"]["theme"]): string {
  const name = compactGPUName(gpu.name);
  const temp = colorTemp(gpu["temperature.gpu"], theme);
  const util = colorUtil(gpu["utilization.gpu"], theme);
  const power = gpu["power.draw"] != null ? `${Math.round(gpu["power.draw"])}W` : "--";
  const fan = gpu["fan.speed"] != null ? `${gpu["fan.speed"]}%` : "--";

  let vram = "--";
  if (gpu["memory.used"] != null && gpu["memory.total"] != null && gpu["memory.total"] > 0) {
    const used = (gpu["memory.used"] / 1024).toFixed(1);
    const total = (gpu["memory.total"] / 1024).toFixed(1);
    const pct = ((gpu["memory.used"] / gpu["memory.total"]) * 100).toFixed(0);
    vram = `${used} ${total} ${makeBar(Number(pct))} ${colorVramPct(Number(pct), theme)}`;
  }

  return `${name} ${temp} ${util} ${vram} ${power} Fan:${fan}`;
}

function buildGpuTable(gpus: GPUData[]): string {
  const headers = ["GPU", "Temp", "Util", "VRAM", "Use", "Power", "Fan"];
  const rows = gpus.map((g) => {
    let vram = "--";
    let use = "--";
    if (g["memory.used"] != null && g["memory.total"] != null && g["memory.total"] > 0) {
      vram = `${(g["memory.used"] / 1024).toFixed(1)}/${(g["memory.total"] / 1024).toFixed(1)}G`;
      use = `${((g["memory.used"] / g["memory.total"]) * 100).toFixed(0)}%`;
    }
    return [
      g.name ?? "?",
      g["temperature.gpu"] != null ? `${g["temperature.gpu"]}°C` : "--",
      g["utilization.gpu"] != null ? `${g["utilization.gpu"]}%` : "--",
      vram,
      use,
      g["power.draw"] != null ? `${Math.round(g["power.draw"])}W` : "--",
      g["fan.speed"] != null ? `${g["fan.speed"]}%` : "--",
    ];
  });

  const widths = headers.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i]))));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
  const fmt = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");

  const inner = [fmt(headers), sep, ...rows.map(fmt)];
  const w = Math.max(...inner.map((l) => visibleWidth(l)));
  const box = (content: string) => `│ ${pad(content, w)} │`;

  return [
    `╭${"─".repeat(w + 2)}╮`,
    box("GPU Status"),
    box(""),
    ...inner.map(box),
    box(""),
    box("esc to close"),
    `╰${"─".repeat(w + 2)}╯`,
  ].join("\n");
}

class GpuTableComponent implements Focusable {
  focused = false;
  private lines: string[];

  constructor(text: string, private done: () => void) {
    this.lines = text.split("\n");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q" || data === " ") {
      this.done();
    }
  }

  render(): string[] {
    return this.lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const REFRESH_MS = 3000;

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

      // Compact: single-line summary
      const temps = gpus.map((g) => colorTemp(g["temperature.gpu"], ctx.ui.theme));
      const utils = gpus.map((g) => colorUtil(g["utilization.gpu"], ctx.ui.theme));
      const vrams = gpus.map((g) => {
        if (g["memory.used"] != null && g["memory.total"] != null && g["memory.total"] > 0) {
          return colorVramPct(Number(((g["memory.used"] / g["memory.total"]) * 100).toFixed(0)), ctx.ui.theme);
        }
        return "--";
      });
      ctx.ui.setStatus("1-gpu-status", `°C: ${temps.join(" ")}  GPU: ${utils.join(" ")}  VRAM: ${vrams.join(" ")}`);
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

  // ── /gpu-status command (detailed table overlay) ─────────────────

  pi.registerCommand("gpu-status", {
    description: "Show a detailed per-GPU table in the main window",
    handler: async (_args, ctx) => {
      const gpus = await fetchGPUs();
      if (gpus.length === 0) {
        ctx.ui.notify("GPU dashboard is unreachable or no GPUs found.", "error");
        return;
      }
      await ctx.ui.custom(
        (_tui, _theme, _keybindings, done) => new GpuTableComponent(buildGpuTable(gpus), () => done()),
        { overlay: true },
      );
    },
  });

  // ── /gpu-server command (server registry) ────────────────────────

  pi.registerCommand("gpu-server", {
    description: "Switch, add, or remove GPU dashboard servers (bare command = switch)",
    getArgumentCompletions: (prefix) => {
      const subs = ["add", "use", "remove"].filter((s) => s.startsWith(prefix));
      return subs.length > 0 ? subs.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const cfg = loadConfig();
      const label = (s: Server) => `${s.name === cfg.active ? "●" : " "} ${s.name}  ${s.url}`;
      const pick = async (title: string) => {
        const items = cfg.servers.map(label);
        const picked = await ctx.ui.select(title, items);
        return picked ? cfg.servers[items.indexOf(picked)] : undefined;
      };

      const switchTo = async (server: Server) => {
        cfg.active = server.name;
        saveConfig(cfg);
        const gpus = await fetchFrom(server.url);
        ctx.ui.notify(
          gpus.length > 0
            ? `${server.name} (${server.url}) — ${gpus.length} GPU(s)`
            : `${server.name} (${server.url}) is unreachable`,
          gpus.length > 0 ? "info" : "error",
        );
        refreshGPUs(ctx);
      };

      switch (sub) {
        case undefined:
        case "use": {
          const server = rest[0] ? cfg.servers.find((s) => s.name === rest[0]) : await pick("GPU dashboard servers");
          if (server) await switchTo(server);
          return;
        }

        case "add": {
          const name = rest[0] || (await ctx.ui.input("Server name", "e.g. rig2"));
          const raw = rest[1] || (await ctx.ui.input(`URL for ${name}`, "http://192.168.1.42:8181"));
          if (!name || !raw) return;
          const url = normalizeUrl(raw);
          const existing = cfg.servers.find((s) => s.name === name);
          if (existing) existing.url = url;
          else cfg.servers.push({ name, url });
          await switchTo(existing ?? cfg.servers[cfg.servers.length - 1]);
          return;
        }

        case "remove": {
          if (cfg.servers.length < 2) {
            ctx.ui.notify("Keep at least one server configured.", "error");
            return;
          }
          const server = await pick("Remove GPU dashboard");
          if (!server) return;
          cfg.servers = cfg.servers.filter((s) => s.name !== server.name);
          if (cfg.active === server.name) cfg.active = cfg.servers[0].name;
          saveConfig(cfg);
          ctx.ui.notify(`Removed ${server.name}. Active: ${cfg.active}`, "info");
          refreshGPUs(ctx);
          return;
        }

        default:
          ctx.ui.notify("Usage: /gpu-server [use <name> | add <name> <url> | remove <name>]", "info");
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
