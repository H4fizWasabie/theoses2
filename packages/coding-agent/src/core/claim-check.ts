/**
 * Last check before the agent stops: compares the final reply against what this run's tool results
 * actually show, and pushes back once if they disagree. Deterministic, no model call.
 *
 * Why: on 2026-09-26 a multi-block edit to a workspace script failed ("Could not find edits[4]"),
 * so none of its blocks landed; the model never retried, then reported "Done and verified — gate
 * changed". The next scheduled run failed on the unchanged gate. The harness already held the
 * evidence; nothing compared it with the claim.
 *
 * Rules, checked in order, at most one push per run:
 *   A. An edit/write failed and no later edit/write to the same path succeeded (claim-independent).
 *   B. The reply claims verification, but no check command ran after the last file change, or the
 *      last one failed. Skipped when a task plan's verify item already demands that evidence.
 *   C. The user asked for a change, the reply claims it is done, and the run made no tool calls.
 *
 * Read-only commands (grep, cat, ls, git status...) are never evidence either way: self-diagnostic's
 * earlier completion-claim check was removed after 45 false flags, mostly grep's exit 1 on no match.
 */
import type { AgentMessage } from "theoses-agent-core";
import type { AssistantMessage } from "theoses-ai";
import { type CustomMessage, createCustomMessage } from "./messages.ts";
import { FILE_TOOLS, firstLine, textOf } from "./tool-runs.ts";
import { type RunEvidence, readRunEvidence } from "./verification-evidence.ts";

export const CLAIM_CHECK_CUSTOM_TYPE = "claim-check";

const VERIFICATION_CLAIM =
	/\b(verified|tested|tests? pass(ed|es)?|passes|passing|all green|works end[- ]to[- ]end|confirmed working)\b/i;
const FAILURE_ACK = /\b(failed|didn'?t (apply|land|work)|did not (apply|land|work)|not applied|couldn'?t|could not)\b/i;
const CHANGE_REQUEST_VERB =
	/\b(edit|change|update|fix|add|remove|delete|rename|move|create|write|patch|replace|set)\b/i;
const DONE_CLAIM = /\b(done|fixed|updated|changed|added|removed|deleted|renamed|created|applied|patched|all set)\b/i;

export interface ClaimCheckOptions {
	/** A task plan's verify item covers this run, so rule B's evidence check is already enforced there. */
	verifyCovered?: boolean;
	/** When a plan is present, unrelated runtime commands cannot mask its check. */
	verifyCommand?: string;
	/** With a plan, only a check after its verify item was declared counts, as for closing that item. */
	verifyAfter?: string;
	/** The caller's reading of this run, so both judge it the same way; read here (with `cwd`) when absent. */
	evidence?: RunEvidence;
	cwd?: string;
}

function lastReply(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") return m;
	}
	return undefined;
}

/** Returns the push-back text, or undefined when the reply is consistent with the run. Exported for tests. */
export function findClaimProblem(runMessages: AgentMessage[], options: ClaimCheckOptions = {}): string | undefined {
	const reply = lastReply(runMessages);
	if (!reply) return undefined;
	const replyText = textOf(reply.content);
	const evidence = options.evidence ?? readRunEvidence(runMessages, options.cwd ?? process.cwd());
	const { runs } = evidence;

	// A: unresolved failed file changes.
	// ponytail: raw path strings, so a retry via a relative vs absolute path counts as a different file; normalize against cwd if that shows up.
	const unresolved = new Map<string, string>();
	for (const run of runs) {
		if (!FILE_TOOLS.has(run.name) || !run.path) continue;
		if (run.isError) unresolved.set(run.path, firstLine(run.output));
		else unresolved.delete(run.path);
	}
	const unacknowledged = [...unresolved].filter(([path]) => {
		const base = path.split("/").pop() ?? path;
		return !(replyText.includes(base) && FAILURE_ACK.test(replyText));
	});
	if (unacknowledged.length > 0) {
		const list = unacknowledged.map(([path, error]) => `- ${path}: ${error}`).join("\n");
		return `These file changes failed and were never successfully retried, so the file is unchanged (a failed multi-block edit applies none of its blocks):\n${list}\nRe-read the file and redo the change, or tell the user plainly that it did not land. Do not report it as done.`;
	}

	// B: verification claimed without a passing check command after the last file change.
	if (!options.verifyCovered && VERIFICATION_CLAIM.test(replyText)) {
		const { changed, lastChange } = evidence;
		const lastCheck = evidence.check({ command: options.verifyCommand, after: options.verifyAfter });
		if (changed) {
			const what = lastChange?.path ?? firstLine(lastChange?.command ?? "a file", 80);
			if (!lastCheck) {
				return `Your reply claims the change was tested or verified, but no check command ran after your last change (${what}); reading, grepping or syntax/lint-only checks do not count as runtime evidence. Run the check now, or remove the claim.`;
			}
			if (lastCheck.isError) {
				return `Your reply claims the change was tested or verified, but the last check after your changes failed: ${firstLine(lastCheck.output)}. Fix it, or report the failure instead.`;
			}
		}
	}

	// C: claimed a requested change is done without calling any tool.
	if (runs.length === 0 && DONE_CLAIM.test(replyText)) {
		const request = runMessages.find((m) => m.role === "user");
		if (request && CHANGE_REQUEST_VERB.test(textOf(request.content))) {
			return "Your reply says the requested change is done, but you made no tool calls this turn, so nothing was changed. Make the change, or tell the user it has not been done.";
		}
	}
	return undefined;
}

/**
 * Issue #389: adapters such as Telegram deliver only the run's last assistant text, so the reply after a
 * push-back replaces the one it corrected. On 2026-09-27 "Part 02 is live" + links was replaced by
 * "The reopened verify item was just bookkeeping...", and the user had to ask whether it was published.
 */
export const FINAL_REPLY_NOTE =
	"The user will only see your last reply, not the one above. Once this is resolved, write that last reply as the complete answer for the user (results, links, anything deferred and why), not as a report on this check.";

/** One corrective push per run at most; undefined when there is nothing to push. */
export function claimCheck(runMessages: AgentMessage[], options: ClaimCheckOptions = {}): CustomMessage | undefined {
	if (runMessages.some((m) => m.role === "custom" && m.customType === CLAIM_CHECK_CUSTOM_TYPE)) return undefined;
	const problem = findClaimProblem(runMessages, options);
	if (!problem) return undefined;
	console.error(`[claim-check] ${firstLine(problem)}`);
	return createCustomMessage(
		CLAIM_CHECK_CUSTOM_TYPE,
		`[System: harness check of your last reply against this turn's tool results]\n${problem}\n\n${FINAL_REPLY_NOTE}`,
		true,
		undefined,
		new Date().toISOString(),
	);
}
