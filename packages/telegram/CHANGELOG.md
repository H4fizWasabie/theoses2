# Changelog

## [1.0.91] - 2026-09-26

## [1.0.90] - 2026-09-25

- fix: /stop now halts a turn that is still preparing (album wait, session load, attachment download, `/model`). It used to reply "Nothing is queued." and let the turn run.
- refactor: `turn-queue.ts` now owns each turn's whole lifecycle (queued, preparing, running, finishing), /stop and Auto-Resume. The adapter hands it a `prepare` function and maps its `StopDecision` to reply text. The per-message stop request (and its 30s expiry), depth tracking and typing reference counts are gone; the typing indicator follows the queue's busy/idle state and now stays on until the final reply is sent. A pending Auto-Resume is cancelled by a new turn or /stop, no longer by the `/on tool call` toggle.
- refactor: a failed turn's error line comes from the shared `describeFinalError`. No visible change.

## [1.0.89] - 2026-09-25

- fix: only `generate_image` results are delivered as Telegram photos. Images from any tool used to be sent, so reading an image file with `read` and then sending it via bash delivered the photo twice.
- refactor: a failed turn's error now comes from `prompt()`'s `PromptResult.finalError` instead of being rebuilt from `message_end` events. No user-visible change.
- refactor: session opening, the thinking-level default, turn submission, /stop and /model now go through the shared Channel Session module (`createChannelSessions`). `turn-queue.ts` drops `markHaltedByStop`/`consumeHaltedByStop` (a halted turn is now recognized by its `aborted` outcome) and `setRunningTool`/`getRunningTool` (reported by the session's `stop()`). The unmatched-`/model` reply no longer includes an example model id.
- refactor: `inbound.ts` reads each update once (`readInbound`: stop, tool-call-detail toggle, /model, or prompt) and builds the prompt from a message or album (`resolvePrompt`); `turn-view.ts` renders one turn (status message, rich/HTML/plain fallback, provider error, generated photos) through an `Outbox` port with a grammy adapter. `index.ts` keeps only the bot wiring, queue and typing.
- fix: an album's caption now also reaches Turn Settlement when it sits on a later photo (the prompt already used it). The automatic resume after a failed turn is queued directly instead of as a fake Telegram update, and settles no text, so memory consolidation and task-boundary detection no longer judge the harness's own "[automatic resume]" prompt as the owner's words.
- change: the typing indicator is re-sent after every message the bot sends during a turn, not only after the status message.

## [1.0.88] - 2026-09-24

- fix: extracted the /stop, queue and auto-resume state machine (previously ten chat-keyed Maps/Sets inline in `createTelegramBot`) into `turn-queue.ts`, a standalone, unit-testable module. Behavior-preserving - no user-visible change. Dashboard-sharing was considered and rejected: the dashboard adapter's needs (one promise-chain queue, unconditional abort) are much thinner, so a shared module would have only one real caller.
- fix: `scheduleAutoResume` now clears a chat's prior pending auto-resume timer before scheduling a new one, matching `requestStop`'s existing pattern (issue #365). Previously only the map entry was overwritten, so an earlier timer nobody could reach anymore would still fire. Never observed in practice - the adapter always cancels any pending auto-resume before it could schedule a second one for the same chat - but no longer relies on that being the only path.
## [1.0.87] - 2026-09-24

## [1.0.86] - 2026-09-24

- fix: inbound rich messages (formatted pastes, tables) are now read. `messageText` only checked `.text`/`.caption`, so a rich message reached the model as an empty prompt. The rich-message flattener also keeps text from block types it doesn't know (such as tables) and puts separate blocks on separate lines instead of running them together.

## [1.0.85] - 2026-09-24

- changed: Telegram sessions use `defaultThinkingLevel` from settings.json instead of a hardcoded `high` (#60), including resumed sessions whose saved level would otherwise win. Unset still means `high`.

## [1.0.84] - 2026-09-24

- fix: a turn that ends in a provider error after its retries now always shows the error, even when the model narrated before an earlier tool call in the same turn. Previously that narration was sent as the final reply and the error was dropped, so a failed turn looked like the model announcing a step and then idling.
- feat: a turn that ends in a provider error is resumed automatically once after 60s, as if the owner had typed "Proceed". Any owner message (including `/stop`) cancels the pending resume; a resume that fails again is reported and not retried.

## [1.0.81] - 2026-09-23

## [1.0.80] - 2026-09-23

## [1.0.79] - 2026-09-22

## [1.0.76] - 2026-09-21

## [1.0.75] - 2026-09-21

## [1.0.74] - 2026-09-21

## [1.0.73] - 2026-09-20

## [1.0.72] - 2026-09-20

## [1.0.71] - 2026-09-20

## [1.0.70] - 2026-09-20

## [1.0.69] - 2026-09-20

## [1.0.68] - 2026-09-20

## [1.0.67] - 2026-09-20

## [1.0.66] - 2026-09-19

## [1.0.65] - 2026-09-19

## [1.0.64] - 2026-09-19

## [1.0.63] - 2026-09-19

## [1.0.62] - 2026-09-19

## [1.0.61] - 2026-09-19

- fix: the "typing..." indicator now starts when a message is received instead of when its turn reaches the model, so it covers session load after a restart, attachment downloads and queue waits. One indicator per chat is shared by all queued messages, it is re-sent immediately after the bot's first status message (Telegram clears typing when the bot sends a message), the refresh interval is 3s (was 4s, against Telegram's ~5s expiry), and `sendChatAction` failures are logged at most once per 30s instead of being swallowed.

- removed: the Jev urgency pre-screen (`THEOSES_INTENT_ROUTER`) and its prompt stamping. It never fired an urgent verdict in production and cost one Jev call per inbound message; prompts are sent exactly as the message text again.

## [1.0.60] - 2026-09-19

## [1.0.59] - 2026-09-19

## [1.0.58] - 2026-09-18

## [1.0.57] - 2026-09-18

## [1.0.56] - 2026-09-18

- feat: Jev-powered urgency pre-screen (intent-router, `THEOSES_INTENT_ROUTER=off|shadow|on`). One cheap Jev Noul call classifies each inbound Telegram message before the agent turn; in `on` mode messages scoring >= 0.85 get a clock-annotation provenance stamp appended to the prompt. Default `off` is byte-identical to prior behavior. (#268, #269)

## [1.0.55] - 2026-09-18

## [1.0.54] - 2026-09-18

## [1.0.53] - 2026-09-18

- fix: capture reply-to-message context when replying to a rich message (Bot API 10.1 sendRichMessage/rich editMessageText). Telegram never populates `reply_to_message.text`/`.caption` for those - only a `rich_message.blocks` tree comes back - so `replyText()` was silently dropping the quoted context on nearly every reply to a theoses answer. Now flattens `rich_message.blocks` as a fallback.

## [1.0.52] - 2026-09-17

## [1.0.51] - 2026-09-15

## [1.0.49] - 2026-09-15

## [1.0.48] - 2026-09-14

## [1.0.47] - 2026-09-14

## [1.0.44] - 2026-09-13

## [1.0.43] - 2026-09-13

## [1.0.42] - 2026-09-12

## [1.0.41] - 2026-09-12

## [1.0.40] - 2026-09-12

## [1.0.39] - 2026-09-12

## [1.0.38] - 2026-09-12

## [1.0.37] - 2026-09-12

## [1.0.36] - 2026-09-12

## [1.0.35] - 2026-09-12

## [1.0.34] - 2026-09-12

## [1.0.33] - 2026-09-11

## [1.0.32] - 2026-09-11

## [1.0.31] - 2026-09-11

## [1.0.30] - 2026-09-11

## [1.0.29] - 2026-09-11

## [1.0.28] - 2026-09-11

## [1.0.27] - 2026-09-11

## [1.0.26] - 2026-09-11

## [1.0.25] - 2026-09-11

### Added

- Added the Telegram channel package with owner-chat gating, long polling, replies, images, and document artifacts ([#21](https://github.com/H4fizWasabie/theoses2/issues/21)).

### Fixed

- Enabled `convert_doc` by default so documents uploaded over Telegram can actually be read instead of sitting unread as artifacts.
- Fixed pipe-table rendering: table cells keep inline formatting (bold/italic/code) instead of being stripped, and escaped pipes (`\|`) no longer split into phantom columns ([#184](https://github.com/H4fizWasabie/theoses2/pull/184)).
