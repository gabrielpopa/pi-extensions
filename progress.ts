/**
 * Progress Tracker Extension
 *
 * Shows a live panel above the editor while pi is working:
 * - Turn counter + agent state (streaming / thinking)
 * - Active tool calls with elapsed time and short summary
 * - Recently finished tools (last 3) with ✓/✗
 * - Footer status: streaming bar, active tool count, completed count
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveTool {
  name: string;
  started: number;
  ended?: number;
  status: "running" | "done" | "error";
  summary: string;
}

interface ProgressState {
  agentActive: boolean;
  turnIndex: number;
  streaming: boolean;
  tools: Map<string, ActiveTool>;
  completedThisTurn: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(ms: number): string {
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

/** Extract a short one-line summary from tool args */
function extractSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file", "query", "pattern", "name"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

function clamp(s: string, max = 55): string {
  return s.length > max ? s.slice(0, max - 3) + "…" : s;
}

// ---------------------------------------------------------------------------
// Widget renderer
// ---------------------------------------------------------------------------

function renderWidget(state: ProgressState, theme: ExtensionContext["ui"]["theme"]): string[] | undefined {
  if (!state.agentActive && state.tools.size === 0) return undefined;

  const lines: string[] = [];
  const runningTools = [...state.tools.values()].filter((t) => t.status === "running");
  const finishedTools = [...state.tools.values()].filter((t) => t.status !== "running").slice(-3);

  // --- Header row ---
  const parts: string[] = [];

  if (state.turnIndex > 0) {
    parts.push(theme.fg("dim", `turn ${state.turnIndex}`));
  }

  if (state.streaming) {
    parts.push(theme.fg("accent", "▎streaming"));
  } else if (runningTools.length > 0) {
    parts.push(theme.fg("warning", `● ${runningTools.length} tool${runningTools.length > 1 ? "s" : ""}`));
  } else if (state.agentActive) {
    parts.push(theme.fg("dim", "○ thinking"));
  }

  if (parts.length > 0) {
    lines.push(parts.join(` ${theme.fg("dim", "|")} `));
  }

  // --- Running tools ---
  for (const tool of runningTools) {
    const age = elapsed(Date.now() - tool.started);
    const label = theme.fg("accent", tool.name);
    const summary = tool.summary ? ` ${theme.fg("dim", clamp(tool.summary))}` : "";
    lines.push(`${theme.fg("warning", "◌")} ${label}${summary} ${theme.fg("dim", age)}`);
  }

  // --- Recently finished tools ---
  for (const tool of finishedTools) {
    const icon = tool.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const label = theme.fg("muted", tool.name);
    const dur = tool.ended ? elapsed(tool.ended - tool.started) : "";
    const summary = tool.summary ? ` ${theme.fg("dim", clamp(tool.summary))}` : "";
    lines.push(`${icon} ${label}${summary}${dur ? ` ${theme.fg("dim", dur)}` : ""}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const state: ProgressState = {
    agentActive: false,
    turnIndex: 0,
    streaming: false,
    tools: new Map(),
    completedThisTurn: 0,
  };

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let currentCtx: ExtensionContext | null = null;

  function refreshWidget(ctx: ExtensionContext) {
    const lines = renderWidget(state, ctx.ui.theme);
    if (lines) {
      ctx.ui.setWidget("progress", lines, { placement: "aboveEditor" });
    } else {
      ctx.ui.setWidget("progress", undefined);
    }

    // Footer status bar
    if (state.agentActive) {
      const running = [...state.tools.values()].filter((t) => t.status === "running").length;
      const parts: string[] = [];
      if (state.streaming) parts.push(ctx.ui.theme.fg("accent", "▎"));
      if (running > 0) parts.push(ctx.ui.theme.fg("warning", `${running}⠿`));
      if (state.completedThisTurn > 0) parts.push(ctx.ui.theme.fg("dim", `${state.completedThisTurn}✓`));
      ctx.ui.setStatus("progress", parts.join(" "));
    } else {
      ctx.ui.setStatus("progress", undefined);
    }
  }

  function startRefresh(ctx: ExtensionContext) {
    if (refreshTimer) return;
    currentCtx = ctx;
    refreshTimer = setInterval(() => {
      if (currentCtx) refreshWidget(currentCtx);
    }, 500);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // --- Agent lifecycle ---

  pi.on("agent_start", async (_event, ctx) => {
    state.agentActive = true;
    startRefresh(ctx);
    refreshWidget(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    state.agentActive = false;
    state.tools.clear();
    state.completedThisTurn = 0;
    state.streaming = false;
    stopRefresh();
    refreshWidget(ctx);
  });

  // --- Turn lifecycle ---

  pi.on("turn_start", async (event, ctx) => {
    state.turnIndex = event.turnIndex + 1;
    state.completedThisTurn = 0;
    state.tools.clear();
    refreshWidget(ctx);
  });

  // --- Message streaming ---

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") {
      state.streaming = true;
    }
    refreshWidget(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      state.streaming = false;
    }
    refreshWidget(ctx);
  });

  // --- Tool execution ---

  pi.on("tool_execution_start", async (event, ctx) => {
    state.tools.set(event.toolCallId, {
      name: event.toolName,
      started: Date.now(),
      status: "running",
      summary: extractSummary(event.args),
    });
    refreshWidget(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const tool = state.tools.get(event.toolCallId);
    if (tool) {
      tool.status = event.isError ? "error" : "done";
      tool.ended = Date.now();
    }
    state.completedThisTurn++;
    refreshWidget(ctx);
  });
}
