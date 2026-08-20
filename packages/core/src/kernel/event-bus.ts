import type { EventBusApi, KernelEvent } from './contract.js';

type KernelEventHandler<T = any> = (event: KernelEvent<T>) => Promise<void> | void;

export class MicrokernelEventBus implements EventBusApi {
  private handlers = new Map<string, KernelEventHandler[]>();
  private eventHistory: KernelEvent[] = [];
  private maxHistory = 100;

  public on<T = unknown>(eventType: string, handler: (event: KernelEvent<T>) => Promise<void> | void): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler as KernelEventHandler);
  }

  public async emit<T = unknown>(eventType: string, payload: T, source = 'kernel'): Promise<void> {
    const event: KernelEvent<T> = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: eventType,
      timestamp: new Date().toISOString(),
      source,
      traceId: `trace_${Math.random().toString(36).slice(2, 9)}`,
      payload,
    };

    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    const list = this.handlers.get(eventType) || [];
    for (const fn of list) {
      try {
        await fn(event);
      } catch (err: any) {
        console.error(`[EventBus] Error in handler for event '${eventType}' from source '${source}':`, err.message);
      }
    }
  }

  public getHistory(limit = 20): KernelEvent[] {
    return this.eventHistory.slice(-limit);
  }

  public clear(): void {
    this.handlers.clear();
    this.eventHistory = [];
  }
}
