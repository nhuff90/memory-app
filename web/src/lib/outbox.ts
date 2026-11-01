import { createStore, del, set, values, type UseStore } from "idb-keyval";
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, createMemory, errorMessage, type PhotoBlobs } from "../api";

export interface OutboxItem {
  /** Sent with every attempt, so the server keeps one copy even if an earlier attempt got through. */
  clientId: string;
  body: string;
  createdAt: number;
  photos: PhotoBlobs[];
  /** Set when the server refused it; it then waits for the user to edit or discard it. */
  error?: string;
}

export interface OutboxStorage {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(clientId: string): Promise<void>;
}

export type SaveResult = "sent" | "queued" | "rejected";

const RETRY_EVERY_MS = 30_000;

/** Offline, signed out, rate limited, or a server hiccup: worth trying again later. */
function worthRetrying(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * New memories are written to this device first, then uploaded. Anything that can't be sent yet
 * (no signal in the basement) stays here and goes up later, oldest first.
 */
export class Outbox {
  private items: OutboxItem[] = [];
  private flushing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly sentListeners = new Set<() => void>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly storage: OutboxStorage,
    private readonly send: (item: OutboxItem) => Promise<unknown>,
  ) {
    this.ready = storage
      .all()
      .then((items) => {
        this.items = items.sort((a, b) => a.createdAt - b.createdAt);
        this.notify();
      })
      .catch(() => {});
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): OutboxItem[] => this.items;

  onSent(listener: () => void): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }

  async save(item: OutboxItem): Promise<SaveResult> {
    await this.ready;
    try {
      await this.storage.put(item);
    } catch {
      // No storage on this device (some private modes): upload directly, and let errors reach the caller.
      await this.send(item);
      this.sentListeners.forEach((listener) => listener());
      return "sent";
    }
    this.items = [...this.items, item];
    this.notify();
    await this.flush();
    const stored = this.items.find((entry) => entry.clientId === item.clientId);
    return !stored ? "sent" : stored.error ? "rejected" : "queued";
  }

  flush(): Promise<void> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async discard(clientId: string): Promise<void> {
    await this.storage.remove(clientId).catch(() => {});
    this.items = this.items.filter((item) => item.clientId !== clientId);
    this.notify();
  }

  private async run(): Promise<void> {
    await this.ready;
    const tried = new Set<string>();
    for (;;) {
      // Re-read each time: memories saved while this runs go out in the same pass.
      const item = this.items.find((entry) => !entry.error && !tried.has(entry.clientId));
      if (!item) return;
      tried.add(item.clientId);
      try {
        await this.send(item);
      } catch (error) {
        if (worthRetrying(error)) return;
        const refused = { ...item, error: errorMessage(error) };
        await this.storage.put(refused).catch(() => {});
        this.items = this.items.map((entry) => (entry.clientId === item.clientId ? refused : entry));
        this.notify();
        continue;
      }
      await this.discard(item.clientId);
      this.sentListeners.forEach((listener) => listener());
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

function indexedDbStorage(): OutboxStorage {
  let store: UseStore | null = null;
  const open = () => (store ??= createStore("recall", "outbox"));
  return {
    all: async () => values<OutboxItem>(open()),
    put: async (item) => set(item.clientId, item, open()),
    remove: async (clientId) => del(clientId, open()),
  };
}

let shared: Outbox | null = null;

export function getOutbox(): Outbox {
  shared ??= new Outbox(indexedDbStorage(), (item) =>
    createMemory({ body: item.body, photos: item.photos, clientId: item.clientId, createdAt: item.createdAt }),
  );
  return shared;
}

export function useOutbox(): OutboxItem[] {
  const outbox = getOutbox();
  return useSyncExternalStore(outbox.subscribe, outbox.snapshot);
}

/** While logged in: upload waiting memories on start, when the connection returns, when the app comes back, and every 30s. */
export function useOutboxSync(active: boolean, onSent: () => void): void {
  useEffect(() => {
    if (!active) return;
    const outbox = getOutbox();
    const flush = () => void outbox.flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };
    const stopListening = outbox.onSent(onSent);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (outbox.snapshot().some((item) => !item.error)) flush();
    }, RETRY_EVERY_MS);
    flush();
    return () => {
      stopListening();
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [active, onSent]);
}
