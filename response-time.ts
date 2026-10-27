/**
 * Response Time Extension
 *
 * Appends elapsed time plus output and prefill throughput (tokens/s) to the footer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnStartTime: number | undefined;
	let firstTokenTime: number | undefined;
	let streamMs = 0;
	let outputTokens = 0;
	let prefillMs = 0;
	let inputTokens = 0;
	let lastAssistantEnd: number | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("2-response-time", "");
	});

	pi.on("agent_start", async (_event, _ctx) => {
		turnStartTime = Date.now();
		streamMs = 0;
		outputTokens = 0;
		prefillMs = 0;
		inputTokens = 0;
		lastAssistantEnd = undefined;
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
		inputTokens += event.message.usage?.input ?? 0;
		const now = Date.now();
		if (firstTokenTime != null) {
			prefillMs += firstTokenTime - (lastAssistantEnd ?? turnStartTime ?? now);
			streamMs += now - firstTokenTime;
		}
		lastAssistantEnd = now;
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
			if (prefillMs > 0 && inputTokens > 0)
				text += theme.fg(
					"dim",
					` · pre ${(inputTokens / (prefillMs / 1000)).toFixed(0)} t/s`,
				);
		}
		console.log(
			`[response-time] ${label} · ${
				streamMs > 0 && outputTokens > 0
					? `${(outputTokens / (streamMs / 1000)).toFixed(1)} t/s`
					: "n/a"
			}${
				prefillMs > 0 && inputTokens > 0
					? ` · prefill ${(inputTokens / (prefillMs / 1000)).toFixed(0)} t/s`
					: ""
			}`,
		);
		ctx.ui.setStatus("2-response-time", icon + text);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("2-response-time", undefined);
	});
}
