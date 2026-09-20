# Changelog

## [Unreleased]

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
