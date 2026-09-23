/**
 * Turn Summary Extension
 *
 * After the agent settles, appends a one-line digest of what happened: files
 * edited with line counts, commands run, lookups, duration. Built locally from
 * tool results — no extra LLM call, no cost.
 *
 * /turn-summary toggles it. Expand entries (ctrl+o) for the per-file list.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Summary, finish, isEmpty, newAcc, parts, record } from "./lib.ts";

export default function (pi: ExtensionAPI) {
	let acc = newAcc(Date.now());
	let enabled = true;

	pi.registerEntryRenderer<Summary>("turn-summary", (entry, { expanded }, theme) => {
		const s = entry.data!;
		const chunks = parts(s).map((part) => (/ failed$/.test(part) ? theme.fg("error", part) : theme.fg("dim", part)));
		const lines = [`${theme.fg("accent", "◆")} ${chunks.join(theme.fg("dim", " · "))}`];

		if (expanded) {
			for (const f of s.files) lines.push(theme.fg("dim", `  ${f.path} +${f.added} -${f.removed}`));
			for (const c of s.commands) lines.push(theme.fg("dim", `  $ ${c.trim().split("\n")[0]}`));
			lines.push(theme.fg("dim", "  ⌃O collapse"));
		} else {
			lines.push(theme.fg("dim", "  ⌃O expand"));
		}

		return new Text(lines.join("\n"), 1, 0);
	});

	pi.on("session_start", async () => {
		acc = newAcc(Date.now());
	});

	pi.on("agent_start", async () => {
		// Retries and queued follow-ups re-fire agent_start mid-run; keep the first timestamp.
		if (isEmpty(finish(acc, Date.now()))) acc = newAcc(Date.now());
	});

	pi.on("tool_result", async (event) => {
		record(acc, event.toolName, event.input, (event as any).details, event.isError);
	});

	pi.on("agent_settled", async () => {
		const summary = finish(acc, Date.now());
		acc = newAcc(Date.now());
		if (enabled && !isEmpty(summary)) pi.appendEntry("turn-summary", summary);
	});

	pi.registerCommand("turn-summary", {
		description: "Toggle the end-of-turn digest line",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Turn summaries ${enabled ? "on" : "off"}`, "info");
		},
	});
}
