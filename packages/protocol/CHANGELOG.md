# Changelog

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

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Breaking Changes

- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.
- Replaced `SessionSummarySchema` and `SessionSummary` with durable `SessionMetadataSchema` and `SessionMetadata` for session lists; runtime state remains in acquired `SessionSnapshot` values ([#7708](https://github.com/earendil-works/pi/pull/7708)).

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
- Added `not_implemented` and `internal_error` protocol error codes for sanitized server failures ([#7644](https://github.com/earendil-works/pi/pull/7644)).
