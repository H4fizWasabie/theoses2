# Changelog

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
