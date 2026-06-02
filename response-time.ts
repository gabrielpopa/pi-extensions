/**
 * Response Time Extension
 *
 * Appends the elapsed time (from user input to end of agent output) to the
 * end of every assistant response in the session footer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnStartTime: number | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("response-time", "");
	});

	pi.on("agent_start", async (_event, _ctx) => {
		turnStartTime = Date.now();
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
		const timeText = theme.fg("dim", ` ${label}`);
		ctx.ui.setStatus("response-time", icon + timeText);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("response-time", undefined);
	});
}
