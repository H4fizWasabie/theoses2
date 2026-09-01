# Pi Runtime Ownership Intake

Date: 2026-09-01
Origin: Owner-approved Theoses runtime ownership decision

## Problem

Theoses runs against published Pi runtime packages and cannot safely remove or redesign
unused Pi capabilities while keeping the working application as the behavioural baseline.

## Who hits it

The Theoses owner hits this whenever runtime behaviour, context assembly, compaction, or
assistant capabilities need to change. The current package boundary makes those changes
dependent on upstream package structure and release decisions.

## Smallest solving change

Track the exact Pi `v0.84.3` source snapshot inside Theoses, make the application build from
that owned source, and preserve the current live behaviour before trimming anything.

## Growth risk and scope line

If unchecked, this becomes a second full Pi distribution with a parallel release process.
This milestone owns only the source and build boundary needed by Theoses; it does not yet
redesign context, convert the agent into a personal assistant, or remove runtime features.

## Surfaces touched

- Git ownership and source provenance
- Local package/workspace resolution
- Pi runtime package names and imports
- Theoses build and test configuration
- Runtime baseline verification
- Documentation and changelog

## Acceptance criteria

1. The Pi `v0.84.3` source is tracked as ordinary files inside Theoses, without a nested Git
   repository controlling it.
2. A provenance record identifies the upstream repository, tag, commit, license, and owned
   package set.
3. Theoses resolves its Pi runtime imports from the tracked source, not from the published
   `@earendil-works/pi-*` packages.
4. Existing typecheck, lint, and test commands pass against the owned source.
5. The existing live-safe runtime behaviour remains unchanged; context redesign and feature
   trimming are explicitly deferred to later pipeline runs.

## Rejection check

This does not match a rejected idea. It is an ownership and dependency-boundary change
required before the approved context redesign.

## Checkpoint

Stage 02 must decide whether to retain the Pi monorepo layout under `pi/`, reduce it to a
Theoses workspace, or use a smaller owned package layout before Stage 03 changes package
resolution or removes the nested Git metadata.
