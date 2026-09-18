/**
 * Jev-powered intent pre-screening for inbound channel messages (issue #268).
 *
 * One cheap askJevNoul call stamps each message with an urgency probability before the
 * expensive agent model reads it. The agent model remains the safety net — a mis-sort never
 * changes what the agent eventually sees verbatim, it only adds a notice line. Gated behind
 * THEOSES_INTENT_ROUTER so verdicts can be observed in shadow mode before behavior changes.
 */
import { askJevNoul } from "./jev-client.ts";

export type IntentRouterMode = "off" | "shadow" | "on";

/** State carries the message text only; keeping it small keeps Jev's answer cheap and fast. */
const MAX_STATE_CHARS = 2000;
/** At/above this Noul probability the message is stamped urgent. Calibrate from shadow logs. */
const URGENT_PROBABILITY_THRESHOLD = 0.85;
/** Jev adds ~100-500ms; anything past this is treated as "no verdict" rather than a stall. */
const JEV_TIMEOUT_MS = 3000;

const URGENCY_INSTRUCTIONS =
	"Does this message convey urgency, time-sensitivity, or an outage requiring immediate attention? " +
	"Consider it urgent if a real-world system or deadline is at risk right now (e.g. service down, " +
	"data being lost, an imminent external deadline). Routine task requests, questions, and casual " +
	"chat are NOT urgent.";

/** Log prefix so shadow-mode verdicts are greppable from journalctl. */
const LOG_PREFIX = "[intent-router]";

export interface UrgencyVerdict {
	mode: IntentRouterMode;
	isUrgent: boolean;
	/** 0-1 Noul probability, undefined when Jev was skipped or failed. */
	probability?: number;
}

/** Reads the env gate once per call so a live config change takes effect without a restart. */
export function resolveIntentRouterMode(): IntentRouterMode {
	const raw = process.env.THEOSES_INTENT_ROUTER?.trim().toLowerCase();
	if (raw === "shadow") return "shadow";
	if (raw === "on") return "on";
	return "off";
}

/**
 * Classifies one inbound message for urgency. Never rejects — a Jev failure or timeout returns
 * `{ isUrgent: false }` and the message proceeds exactly as it would without the router.
 * `askNoul` is injectable for tests.
 */
export async function classifyUrgency(
	text: string,
	options: { mode?: IntentRouterMode; askNoul?: typeof askJevNoul } = {},
): Promise<UrgencyVerdict> {
	const mode = options.mode ?? resolveIntentRouterMode();
	if (mode === "off") return { mode, isUrgent: false };

	const trimmed = text.trim();
	if (!trimmed) return { mode, isUrgent: false };

	const askNoul = options.askNoul ?? askJevNoul;
	const probability = await withTimeout(
		askNoul({ message: trimmed.slice(0, MAX_STATE_CHARS) }, URGENCY_INSTRUCTIONS),
		JEV_TIMEOUT_MS,
	);

	if (probability === undefined) {
		console.error(`${LOG_PREFIX} mode=${mode} no verdict from Jev; proceeding unstamped`);
		return { mode, isUrgent: false };
	}

	const isUrgent = probability >= URGENT_PROBABILITY_THRESHOLD;
	console.log(`${LOG_PREFIX} mode=${mode} urgency=${probability.toFixed(3)} urgent=${isUrgent}`);
	return { mode, isUrgent, probability };
}

/**
 * The one-line observation prepended to the prompt of urgent messages in `on` mode. Worded as
 * an observation about provenance (an automated pre-screen, not abah's own words) so the agent
 * treats it as routing metadata rather than as part of the request.
 */
export function urgentIntakeNotice(): string {
	return (
		"[intake: automated pre-screen classified this message URGENT. If another task is already " +
		"running or queued, acknowledge this promptly and prioritize it over batch work.]"
	);
}

function withTimeout(promise: Promise<number | undefined>, ms: number): Promise<number | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
