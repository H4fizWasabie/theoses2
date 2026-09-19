# Changelog

## [1.0.64] - 2026-09-19

- fix: the memory graph view no longer lags on thousands of nodes. On a graph shaped like the real store (7,913 nodes, 5,232 edges) in headless Chrome, frames went from a 450 ms median (worst 1.1 s, never stopping) to a 17 to 33 ms median with no long tasks, and the animation stops once the layout settles.
  - Layout and simulation moved into a pure, tested module (`graph-layout.js`). Repulsion uses a Barnes-Hut quadtree instead of comparing every node with every other node, edges hold direct node references instead of an `Array.find` per edge per frame, and a cooling schedule lets the layout settle (about 305 steps) instead of simulating forever. Input handlers now request a redraw or reheat the simulation, since the loop no longer runs constantly.
  - Drawing batches all edges into one path and fills nodes once per cluster color, and skips anything outside the viewport. Labels are capped at 400 at a time.
  - The animated background field (a Three.js scene rendered every frame) is paused while the graph view is open. It is fully covered there and was halving the graph's frame rate.
  - `/api/memory-graph` caches its result for 60 seconds (the refresh button bypasses it with `?fresh=1`). Building it reads and parses every memory file synchronously, about 2.6 s for 7.9k nodes, which froze the whole dashboard on every open.
  - The asset allowlist now checks own properties, so names like `constructor` return 404.

## [1.0.63] - 2026-09-19

## [1.0.62] - 2026-09-19

## [1.0.61] - 2026-09-19

## [1.0.60] - 2026-09-19

## [1.0.59] - 2026-09-19

## [1.0.58] - 2026-09-18

## [1.0.57] - 2026-09-18

## [1.0.56] - 2026-09-18

## [1.0.55] - 2026-09-18

## [1.0.54] - 2026-09-18

## [1.0.53] - 2026-09-18

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

- Added the private dashboard chat and filesystem workbench.

### Fixed

- Gave the login cookie a one-year `Max-Age` so sign-in persists instead of expiring as a browser session cookie and forcing an unexpected re-login.
