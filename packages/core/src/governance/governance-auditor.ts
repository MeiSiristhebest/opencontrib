/**
 * Backward-compatible shim. The pure governance-audit logic now lives in the
 * dependency-free `domain/` layer (Task 8). This file only re-exports it so the
 * existing call sites keep importing from the original path.
 */
export * from '../domain/governance.js';
