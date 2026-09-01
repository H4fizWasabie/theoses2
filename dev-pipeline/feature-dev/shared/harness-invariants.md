# Theoses Runtime Invariants

These are properties a change must preserve unless the design explicitly changes one and
records the migration.

## Runtime ownership

Theoses must build from the tracked source in `pi/`, not an accidental upstream package.

## Context is bounded and inspectable

Conversation, resource, tool, and memory growth must degrade predictably. Model-facing
context selection must be explainable from local state.

## Coding capability remains available

The personal-assistant direction must not remove the coding tools, project workspace, file
operations, shell execution, sessions, branching, or compaction needed for coding work.

## Failure is explicit

Provider timeouts, malformed responses, cancellation, context exhaustion, and tool failures
must surface as defined states. No silent retry or silent data loss.

## State stays local and inspectable

Sessions, context records, configuration, and audit information remain readable from the
owner-controlled filesystem.

## Web/runtime boundary stays clear

The browser forwards input and renders state. Runtime truth and enforcement belong in the
agent runtime or server boundary, not only in React.
