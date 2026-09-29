import { type ChannelSession, describeRewindResult } from "theoses-coding-agent";

const LISTED = 5;
const QUOTE_CHARS = 60;

const quote = (text: string): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return `"${flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}...` : flat}"`;
};

/**
 * The reply to `/rewind [<number> [yes]]`: no argument lists the recent turns that changed files, a number
 * previews putting the files back to before that turn, and `yes` does it. The conversation is never touched.
 * Numbers are positions in the list as it is now, so the preview quotes the turn to confirm the right one.
 */
export function rewindReply(session: ChannelSession, args: string): string {
	if (session.isRunning) return "A turn is running. /stop it first, then rewind.";
	const points = session.rewindPoints(LISTED);
	if (args === "") {
		if (points.length === 0) return "No turn has changed files yet.";
		const lines = points.map((point, index) => `${index + 1}. ${quote(point.text)}`);
		return `Files changed in these turns (newest first):\n${lines.join("\n")}\nPreview one with /rewind <number>.`;
	}

	const [number, confirm, ...extra] = args.split(/\s+/);
	const point = /^\d+$/.test(number) ? points[Number(number) - 1] : undefined;
	if (!point || extra.length > 0 || (confirm !== undefined && confirm.toLowerCase() !== "yes")) {
		return "Send /rewind to see the numbers, then /rewind <number> or /rewind <number> yes.";
	}
	if (confirm === undefined) {
		return `Rewind files to before ${quote(point.text)}?\n${session.previewRewind(point.entryId)}\nThe conversation stays as it is. Confirm with /rewind ${number} yes.`;
	}
	return `Rewound files to before ${quote(point.text)}.\n${describeRewindResult(session.rewind(point.entryId))}`;
}
