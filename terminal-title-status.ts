/**
 * Terminal Title Status Extension
 *
 * Shows a spinner + current tool name in the terminal title while pi is working
 * and restores a clean title when done.
 *
 * Usage:
 *   pi (auto-discovered from ~/.pi/agent/extensions/)
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER = ["-", "\\", "|", "/"];

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pi.getSessionName();
	return session ? `pi - ${session}` : `pi - ${cwd}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let currentTool = "working";

	function clearTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function ensureSpinner(ctx: ExtensionContext) {
		if (timer) return;
		timer = setInterval(() => {
			const ch = SPINNER[frameIndex % SPINNER.length];
			ctx.ui.setTitle(`pi ${ch} ${currentTool}`);
			frameIndex++;
		}, 100);
	}

	function stopSpinner(ctx: ExtensionContext) {
		clearTimer();
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(pi));
	}

	pi.on("agent_start", async (_event, ctx) => {
		currentTool = "working";
		ensureSpinner(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		currentTool = event.toolName === "ask_user_question" ? "waiting" : event.toolName;
		ensureSpinner(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopSpinner(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearTimer();
		ctx.ui.setTitle(path.basename(process.cwd()));
	});
}
