/** Pure digest logic for the turn-summary extension (no pi imports, so it is testable). */

export type FileStat = { path: string; added: number; removed: number };

export type Acc = {
	startedAt: number;
	files: Map<string, FileStat>;
	commands: string[];
	reads: number;
	searches: number;
	others: number;
	errors: number;
};

export type Summary = {
	files: FileStat[];
	commands: string[];
	reads: number;
	searches: number;
	others: number;
	errors: number;
	ms: number;
};

/** Count added/removed lines in a unified patch (ignores +++/--- headers). */
export function countDiff(patch: string): [number, number] {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return [added, removed];
}

export function newAcc(startedAt: number): Acc {
	return { startedAt, files: new Map(), commands: [], reads: 0, searches: 0, others: 0, errors: 0 };
}

export function record(acc: Acc, toolName: string, input: any, details: any, isError: boolean): void {
	if (isError) acc.errors++;

	const path = typeof input?.path === "string" ? input.path : undefined;
	if (!isError && (toolName === "edit" || toolName === "write") && path) {
		const [added, removed] =
			toolName === "edit"
				? countDiff(typeof details?.patch === "string" ? details.patch : "")
				: [String(input?.content ?? "").split("\n").length, 0];
		const file = acc.files.get(path) ?? { path, added: 0, removed: 0 };
		file.added += added;
		file.removed += removed;
		acc.files.set(path, file);
		return;
	}

	if (toolName === "bash") {
		if (typeof input?.command === "string") acc.commands.push(input.command);
	} else if (toolName === "read") {
		acc.reads++;
	} else if (toolName === "grep" || toolName === "find" || toolName === "ls") {
		acc.searches++;
	} else {
		acc.others++;
	}
}

export function finish(acc: Acc, now: number): Summary {
	return {
		files: [...acc.files.values()],
		commands: acc.commands,
		reads: acc.reads,
		searches: acc.searches,
		others: acc.others,
		errors: acc.errors,
		ms: Math.max(0, now - acc.startedAt),
	};
}

export function isEmpty(s: Summary): boolean {
	return (
		s.files.length === 0 &&
		s.commands.length === 0 &&
		s.reads === 0 &&
		s.searches === 0 &&
		s.others === 0 &&
		s.errors === 0
	);
}

export function duration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Digest as plain text chunks, e.g. ["edited lib.ts +3 -1", "ran npm test", "42.1s"]. */
export function parts(s: Summary): string[] {
	const out: string[] = [];
	const added = s.files.reduce((n, f) => n + f.added, 0);
	const removed = s.files.reduce((n, f) => n + f.removed, 0);

	if (s.files.length === 1) out.push(`edited ${base(s.files[0].path)} +${added} -${removed}`);
	else if (s.files.length > 1) out.push(`edited ${s.files.length} files +${added} -${removed}`);

	if (s.commands.length === 1) out.push(`ran ${clip(s.commands[0])}`);
	else if (s.commands.length > 1) out.push(`${s.commands.length} commands`);

	const looked = s.reads + s.searches;
	if (looked > 0) out.push(`${looked} looked up`);
	if (s.others > 0) out.push(`${s.others} other tools`);
	out.push(duration(s.ms));
	if (s.errors > 0) out.push(`${s.errors} failed`);
	return out;
}

function base(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function clip(text: string, max = 48): string {
	const first = text.trim().split("\n")[0];
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
