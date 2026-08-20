import type { EventBusApi, RepoFingerprint, PointerStoreApi } from './contract.js';

type EventHandler = (payload: any) => Promise<void> | void;

export class MicrokernelEventBus implements EventBusApi {
  private handlers = new Map<string, EventHandler[]>();

  public on(event: 'repo:fingerprint', handler: (fp: RepoFingerprint) => Promise<void> | void): void;
  public on(event: 'scout:opportunity', handler: (ctx: { target: string; pointers: PointerStoreApi }) => Promise<void> | void): void;
  public on(event: 'evidence:verify', handler: (ctx: { findingUri: string; pointers: PointerStoreApi }) => Promise<void> | void): void;
  public on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  public async emit(event: string, payload: unknown): Promise<void> {
    const list = this.handlers.get(event) || [];
    for (const fn of list) {
      try {
        await fn(payload);
      } catch (err) {
        console.error(`[EventBus] Error in handler for event '${event}':`, err);
      }
    }
  }

  public clear(): void {
    this.handlers.clear();
  }
}
