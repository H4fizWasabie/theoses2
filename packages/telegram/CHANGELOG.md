# Changelog

## [Unreleased]

## [1.0.25] - 2026-09-11

### Added

- Added the Telegram channel package with owner-chat gating, long polling, replies, images, and document artifacts ([#21](https://github.com/H4fizWasabie/theoses2/issues/21)).

### Fixed

- Enabled `convert_doc` by default so documents uploaded over Telegram can actually be read instead of sitting unread as artifacts.
- Fixed pipe-table rendering: table cells keep inline formatting (bold/italic/code) instead of being stripped, and escaped pipes (`\|`) no longer split into phantom columns ([#184](https://github.com/H4fizWasabie/theoses2/pull/184)).
