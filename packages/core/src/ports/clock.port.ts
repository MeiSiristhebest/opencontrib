/**
 * Clock port — injectable time source.
 *
 * Domain logic that needs "now" must receive a Clock instead of calling
 * `Date.now()` / `new Date()` directly. This makes time-based scoring and
 * manifest timestamps deterministic and unit-testable (see `FixedClock`).
 */

export interface Clock {
  /** Current time as a Date. */
  now(): Date;
  /** Current time as an ISO-8601 string (e.g. manifest `createdAt`). */
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  private readonly fixed: Date;
  constructor(isoOrDate: string | Date = '2026-01-01T00:00:00.000Z') {
    this.fixed = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  }
  now(): Date {
    return this.fixed;
  }
  nowIso(): string {
    return this.fixed.toISOString();
  }
}
