/**
 * Per-turn clock annotation, appended to the user's message text (never the system prompt)
 * so the model has an authoritative sense of the current time without invalidating the
 * cached system-prompt/tool-definition prefix on every call (see issue #204's compaction
 * cache-invalidation writeup for why anything in the shared prefix must stay byte-stable).
 *
 * Because it's appended to the per-turn text that already gets persisted verbatim into the
 * session, each historical turn's annotation is frozen at whatever time it was sent — replaying
 * it byte-for-byte matches what was previously cached. Only the newest turn's annotation is new
 * content, which was never cached anyway.
 */

const CLOCK_ANNOTATION_PREFIX = "\n\n[AUTHORITATIVE CLOCK: ";
const CLOCK_ANNOTATION_SUFFIX = ". Use this as the current time; do not infer it from conversation history.]";

/** Builds the clock annotation for the given instant, in the given IANA time zone
 * (defaults to the host's local time zone). */
export function formatClockAnnotation(now: Date = new Date(), timeZone?: string): string {
	const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "long",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZoneName: "shortOffset",
	})
		.formatToParts(now)
		.reduce<Record<string, string>>((acc, part) => {
			acc[part.type] = part.value;
			return acc;
		}, {});

	const formatted = `${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName ?? zone}`;
	return `${CLOCK_ANNOTATION_PREFIX}${formatted}${CLOCK_ANNOTATION_SUFFIX}`;
}

/** Strips a trailing clock annotation from user-facing text, so UIs that render the persisted
 * message verbatim (dashboard, interactive terminal) don't show the harness-injected block. */
export function stripClockAnnotation(text: string): string {
	const index = text.indexOf(CLOCK_ANNOTATION_PREFIX);
	return index === -1 ? text : text.slice(0, index);
}
