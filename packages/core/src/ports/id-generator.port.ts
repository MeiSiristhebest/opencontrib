/**
 * IdGenerator port — injectable identifier source.
 *
 * Replaces ad-hoc `Math.random().toString(36)` calls so generated run ids are
 * deterministic in tests and swappable (e.g. to a UUID v7 generator) in prod.
 */

export interface IdGenerator {
  /** Generate an opaque id, optionally prefixed (e.g. `run_`). */
  generate(prefix?: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  generate(prefix = ''): string {
    return `${prefix}${Math.random().toString(36).substring(2, 8)}`;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter: number;
  constructor(seed = 0) {
    this.counter = seed;
  }
  generate(prefix = ''): string {
    this.counter += 1;
    return `${prefix}${this.counter.toString(36).padStart(4, '0')}`;
  }
}
