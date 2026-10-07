/**
 * Response Time Extension
 *
 * Appends the elapsed time (from user input to end of agent output) and the
 * streaming throughput (output tokens/s, prefill excluded) to the session footer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnStartTime: number | undefined;
	let firstTokenTime: number | undefined;
	let streamMs = 0;
	let outputTokens = 0;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("2-response-time", "");
	});

	pi.on("agent_start", async (_event, _ctx) => {
		turnStartTime = Date.now();
		streamMs = 0;
		outputTokens = 0;
		firstTokenTime = undefined;
	});

	// Prefill ends with the first delta of each assistant message; count only
	// post-prefill time so tool calls and prefill don't drag TPS down.
	pi.on("message_start", async (event, _ctx) => {
		if (event.message.role === "assistant") firstTokenTime = undefined;
	});

	pi.on("message_update", async (event, _ctx) => {
		if (event.message.role === "assistant" && firstTokenTime == null)
			firstTokenTime = Date.now();
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		outputTokens += event.message.usage?.output ?? 0;
		if (firstTokenTime != null) streamMs += Date.now() - firstTokenTime;
		firstTokenTime = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (turnStartTime == null) return;

		const elapsed = Date.now() - turnStartTime;
		turnStartTime = undefined;

		const minutes = Math.floor(elapsed / 60_000);
		const seconds = ((elapsed % 60_000) / 1000).toFixed(1);

		let label: string;
		if (minutes > 0) {
			label = `${minutes}m ${seconds}s`;
		} else {
			label = `${seconds}s`;
		}

		const theme = ctx.ui.theme;
		const icon = theme.fg("success", "⏱");
		let text = theme.fg("dim", ` ${label}`);
		if (streamMs > 0 && outputTokens > 0) {
			const tps = outputTokens / (streamMs / 1000);
			text += theme.fg("dim", ` · ${tps.toFixed(1)} t/s`);
		}
		ctx.ui.setStatus("2-response-time", icon + text);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("2-response-time", undefined);
	});
}
