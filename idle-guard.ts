/**
 * Stream Idle Guard Extension
 *
 * Detects when the model stream goes silent (no tokens for a threshold) and
 * automatically aborts the hung turn so pi stops being stuck on "Working...".
 *
 * Handles two phases:
 *   1. PREFILL — model is processing context before first token (long with big history)
 *   2. STREAMING — tokens should arrive continuously; silence here = hang
 *
 * Uses a longer threshold for prefill and a shorter one once tokens start flowing.
 *
 * Commands:
 *   /idle-guard              Show current status
 *   /idle-guard on           Enable (default)
 *   /idle-guard off          Disable
 *   /idle-guard 180 60       Set prefill=180s, stream=60s
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREFILL_THRESHOLD_MS = 180_000; // 3 minutes for initial context processing
const DEFAULT_STREAM_THRESHOLD_MS = 45_000;   // 45 seconds once tokens are flowing
const MIN_PREFILL_SEC = 30;
const MAX_PREFILL_SEC = 600;
const MIN_STREAM_SEC = 10;
const MAX_STREAM_SEC = 300;

export default function (pi: ExtensionAPI) {
    let enabled = true;
    let prefillThresholdMs = DEFAULT_PREFILL_THRESHOLD_MS;
    let streamThresholdMs = DEFAULT_STREAM_THRESHOLD_MS;

    // Per-turn state
    let lastActivityTime = 0;
    let turnStartTime = 0;
    let timerId: ReturnType<typeof setInterval> | null = null;
    let turnActive = false;
    let firstTokenReceived = false;
    let currentCtx: ExtensionContext | null = null;

    function stopMonitoring() {
        if (timerId) {
            clearInterval(timerId);
            timerId = null;
        }
        turnActive = false;
    }

    function startMonitoring(ctx: ExtensionContext) {
        stopMonitoring();
        currentCtx = ctx;
        lastActivityTime = Date.now();
        turnStartTime = Date.now();
        turnActive = true;
        firstTokenReceived = false;

        timerId = setInterval(() => {
            if (!turnActive) return;

            const threshold = firstTokenReceived ? streamThresholdMs : prefillThresholdMs;
            const phase = firstTokenReceived ? "stream" : "prefill";
            const silenceMs = Date.now() - lastActivityTime;

            if (silenceMs >= threshold) {
                turnActive = false;
                clearInterval(timerId!);
                timerId = null;

                const silenceSeconds = (silenceMs / 1000).toFixed(0);
                console.error(`[idle-guard] Stream idle for ${silenceSeconds}s (${phase}) — aborting`);

                try {
                    ctx.ui.notify(
                        `Stream hung (${silenceSeconds}s idle, ${phase}), aborting`,
                        "warning"
                    );
                } catch {}

                ctx.abort();
            }
        }, 2_000);
    }

    pi.on("session_start", async (_event, ctx) => {
        ctx.ui.setStatus(
            "idle-guard",
            ctx.ui.theme.fg("dim", `Idle guard: on (prefill ${prefillThresholdMs / 1000}s / stream ${streamThresholdMs / 1000}s)`)
        );
    });

    pi.on("agent_start", async (_event, ctx) => {
        if (!enabled) return;
        startMonitoring(ctx);
    });

    pi.on("message_update", async (_event, _ctx) => {
        if (!turnActive || !enabled) return;

        lastActivityTime = Date.now();

        // First token delta means prefill is done
        if (!firstTokenReceived) {
            firstTokenReceived = true;
            const prefillMs = Date.now() - turnStartTime;
            console.log(`[idle-guard] Prefill done in ${(prefillMs / 1000).toFixed(1)}s`);
        }
    });

    pi.on("agent_end", async (_event, _ctx) => {
        stopMonitoring();
    });

    pi.on("agent_settled", async (_event, _ctx) => {
        stopMonitoring();
    });

    pi.registerCommand("idle-guard", {
        description: "Manage stream idle detection (on/off/thresholds)",
        handler: async (args, ctx) => {
            const trimmed = (args || "").trim().toLowerCase();

            if (!trimmed) {
                const status = enabled
                    ? `ON (prefill: ${prefillThresholdMs / 1000}s, stream: ${streamThresholdMs / 1000}s)`
                    : "OFF";
                ctx.ui.notify(`Idle guard: ${status}`, "info");
                return;
            }

            if (trimmed === "on") {
                enabled = true;
            } else if (trimmed === "off") {
                enabled = false;
                stopMonitoring();
            } else {
                const parts = trimmed.split(/\s+/).map(p => parseInt(p, 10));

                if (parts.length === 2 && !parts.some(isNaN)) {
                    const [pSec, sSec] = parts;
                    if (pSec < MIN_PREFILL_SEC || pSec > MAX_PREFILL_SEC) {
                        ctx.ui.notify(`Prefill must be ${MIN_PREFILL_SEC}-${MAX_PREFILL_SEC}s`, "error");
                        return;
                    }
                    if (sSec < MIN_STREAM_SEC || sSec > MAX_STREAM_SEC) {
                        ctx.ui.notify(`Stream must be ${MIN_STREAM_SEC}-${MAX_STREAM_SEC}s`, "error");
                        return;
                    }
                    prefillThresholdMs = pSec * 1000;
                    streamThresholdMs = sSec * 1000;
                } else if (parts.length === 1 && !isNaN(parts[0])) {
                    const sec = parts[0];
                    if (sec < MIN_STREAM_SEC || sec > MAX_PREFILL_SEC) {
                        ctx.ui.notify(`Threshold must be ${MIN_STREAM_SEC}-${MAX_PREFILL_SEC}s`, "error");
                        return;
                    }
                    prefillThresholdMs = sec * 1000;
                    streamThresholdMs = sec * 1000;
                } else {
                    ctx.ui.notify(`Usage: /idle-guard [on|off|<prefillSec> <streamSec>]`, "error");
                    return;
                }
            }

            ctx.ui.setStatus(
                "idle-guard",
                ctx.ui.theme.fg("dim", `Idle guard: ${enabled ? "on" : "off"} (p:${prefillThresholdMs / 1000}s/s:${streamThresholdMs / 1000}s)`)
            );
            ctx.ui.notify(
                `Idle guard: ${enabled ? "ON" : "OFF"} (prefill: ${prefillThresholdMs / 1000}s, stream: ${streamThresholdMs / 1000}s)`,
                "info"
            );
        },
    });
}
