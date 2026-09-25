import type { ThinkingLevel } from "theoses-agent-core";
import type { Api, Model } from "theoses-ai";
import type { AgentSessionEvent, PromptOptions, PromptResult } from "./agent-session.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { createAgentSession } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";

/**
 * Channel Session: the persistent conversation one channel (Telegram, dashboard) keeps for the owner.
 * Owns what every channel adapter needs from an AgentSession - opening or creating it by channel key,
 * the thinking-level policy, one turn at a time, stop, model switch - so adapters only render.
 */
export interface ChannelSession {
	readonly channelSessionId: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly model: Model<Api> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	/** A turn is in progress, including retry backoff. */
	readonly isRunning: boolean;
	/** Runs one turn after any earlier submit finishes. `onEvent` sees only this turn's events. */
	submit(input: ChannelInput, onEvent?: (event: AgentSessionEvent) => void): Promise<PromptResult | undefined>;
	/** Aborts the running turn; queued submits still run. */
	stop(): Promise<{ wasRunning: boolean; runningTool?: string }>;
	/** Session-only switch to the exact `provider/id` match; settings.json's default is untouched. */
	switchModel(reference: string): Promise<{ model: Model<Api> } | { error: string }>;
	storeArtifact(label: string, fileName: string, data: Uint8Array): string;
}

export interface ChannelInput {
	text: string;
	images?: PromptOptions["images"];
	replyContext?: string;
	/** See PromptOptions.settlementText. */
	settlementText?: string;
}

/** The owner-facing line for a turn that still failed after its retries (#211), or undefined if it didn't. */
export function describeFinalError(result: PromptResult | undefined): string | undefined {
	const failure = result?.finalError;
	return failure && `${failure.provider}/${failure.model} failed: ${failure.message}`;
}

export interface ChannelSessionsOptions {
	channel: string;
	/** Where new sessions are created and existing ones are looked up by channel key. */
	cwd: string;
	/** Channel-specific system prompt additions (e.g. Telegram's rich-formatting guidance). */
	appendSystemPrompt?: string[];
}

export type ChannelSessions = ReturnType<typeof createChannelSessions>;

export function createChannelSessions(options: ChannelSessionsOptions) {
	const { channel, cwd } = options;
	const opening = new Map<string, Promise<ChannelSession>>();
	const open: ChannelSession[] = [];

	async function load(channelSessionId: string, sessionFile: string | undefined): Promise<ChannelSession> {
		const key = { channel, channelSessionId };
		let sessionManager: SessionManager;
		if (sessionFile) {
			sessionManager = SessionManager.open(sessionFile);
		} else {
			const matches = await SessionManager.list(cwd, undefined, undefined, key);
			sessionManager = matches[0]
				? SessionManager.open(matches[0].path, undefined, cwd)
				: SessionManager.create(cwd, undefined, key);
		}
		if (sessionManager.getChannelSessionKey().channel !== channel) {
			throw new Error(`Session is not a ${channel} session`);
		}
		const { session } = await createAgentSession({ sessionManager, appendSystemPrompt: options.appendSystemPrompt });
		// settings.json's defaultThinkingLevel wins even over a resumed session's saved level, so a long-lived
		// Channel Session can be retuned with a settings edit and restart. High when unset (#60).
		session.setThinkingLevel(session.settingsManager.getDefaultThinkingLevel() ?? "high");

		let runningTool: string | undefined;
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") runningTool = event.toolName;
			else if (event.type === "tool_execution_end") runningTool = undefined;
		});
		let queue: Promise<unknown> = Promise.resolve();

		return {
			channelSessionId,
			get sessionId() {
				return sessionManager.getSessionId();
			},
			get sessionFile() {
				return sessionManager.getSessionFile();
			},
			get model() {
				return session.model;
			},
			get thinkingLevel() {
				return session.thinkingLevel;
			},
			get isRunning() {
				return session.isStreaming;
			},
			submit(input, onEvent) {
				const turn = queue.then(async () => {
					const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
					try {
						return await session.prompt(input.text, {
							images: input.images,
							replyContext: input.replyContext,
							settlementText: input.settlementText,
							source: "interactive",
						});
					} finally {
						unsubscribe?.();
						runningTool = undefined;
					}
				});
				queue = turn.catch(() => {});
				return turn;
			},
			async stop() {
				const wasRunning = session.isStreaming;
				const tool = runningTool;
				await session.abort();
				return { wasRunning, runningTool: tool };
			},
			async switchModel(reference) {
				const match = findExactModelReferenceMatch(reference, [...session.modelRuntime.getAvailableSnapshot()]);
				if (!match) return { error: `No exact match for "${reference}". Use the canonical provider/id.` };
				try {
					await session.setModel(match, { persist: false });
				} catch (error) {
					return { error: `Couldn't switch model: ${error instanceof Error ? error.message : String(error)}` };
				}
				return { model: match };
			},
			storeArtifact(label, fileName, data) {
				return sessionManager.storeArtifact(label, fileName, data);
			},
		};
	}

	return {
		/**
		 * The Channel Session for `channelSessionId`: already open, else `sessionFile` when the caller has it,
		 * else the newest on disk under `cwd`, else a new one.
		 */
		open(channelSessionId: string, sessionFile?: string): Promise<ChannelSession> {
			const existing = opening.get(channelSessionId);
			if (existing) return existing;
			const created = load(channelSessionId, sessionFile).then(
				(session) => {
					open.push(session);
					return session;
				},
				(error: unknown) => {
					opening.delete(channelSessionId);
					throw error;
				},
			);
			opening.set(channelSessionId, created);
			return created;
		},

		/**
		 * The open Channel Session with this engine session id, including a new one not yet written to disk
		 * (a session file is only flushed once it has an assistant message). Never opens one.
		 */
		find(sessionId: string): ChannelSession | undefined {
			return open.find((session) => session.sessionId === sessionId);
		},
	};
}
