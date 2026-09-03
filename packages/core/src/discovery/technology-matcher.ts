/**
 * Backward-compatible shim. The pure `TechnologyMatcher` now lives in the
 * dependency-free `domain/` layer (Task 8). This file only re-exports it so the
 * 40+ existing call sites and tests keep importing from the original path.
 */
export * from '../domain/matcher.js';
