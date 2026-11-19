import { createStore, del, set, values, type UseStore } from "idb-keyval";
import { useEffect, useSyncExternalStore } from "react";
import { KEYWORD_CAPTURE_CAPABILITY, keywordKey, normalizeKeywords, sameKeywordSet } from "../../../shared/keywords";
import { ApiError, createMemory, errorMessage, getMe, reconcileMemory, type PhotoBlobs } from "../api";

export interface HeldState {
  /**
   * unsupported: the server can't save keywords with a capture and no upload was ever started, so nothing is on the
   *   server; the only state where editing (and later saving under a new clientId) is safe.
   * unverified: an upload may have reached the server (a success without matching keywords, or an interrupted
   *   attempt); it can only be resolved by reconciling its original clientId.
   * conflict: the server has the recall without these keywords and it changed since; the user chooses add or keep.
   */
  reason: "unsupported" | "unverified" | "conflict";
  message: string;
  /** The recall's updatedAt in the server's success response, proving later that it is untouched since. */
  savedUpdatedAt?: number | null;
  /** Recall's current keywords, the held ones it lacks, and the updatedAt the user is deciding against. */
  conflict?: { keywords: string[]; missing: string[]; updatedAt: number };
}

const MAY_ALREADY_EXIST =
  "Recall may already have this memory without its keywords, and this server can't confirm keywords right now. " +
  "Nothing was lost; recover it after the server is updated.";

export interface OutboxItem {
  /** Sent with every attempt, so the server keeps one copy even if an earlier attempt got through. */
  clientId: string;
  body: string;
  createdAt: number;
  photos: PhotoBlobs[];
  /** Saved together with the body and photos. Items stored by older versions have none. */
  customKeywords?: string[];
  /** Set when the server refused it; it then waits for the user to edit or discard it. */
  error?: string;
  /** Needs reconciliation: kept with all its content and never retried automatically. */
  held?: HeldState;
  /** Set (and stored) before any create request is sent: from then on the server may have this capture. */
  uploadStarted?: boolean;
}

export type Resolution = "add" | "keep";
/** Sends one capture. `onUpload` must be awaited right before the create request goes out. */
export type SendCapture = (item: OutboxItem, onUpload: () => Promise<void>) => Promise<unknown>;
export type ReconcileCapture = (item: OutboxItem, onUpload: () => Promise<void>, resolution?: Resolution) => Promise<unknown>;

export interface OutboxStorage {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(clientId: string): Promise<void>;
}

export type SaveResult = "sent" | "queued" | "rejected" | "held";
export type RecoverResult = "recovered" | "held";

/** The capture can't be confirmed as saved with its keywords; hold it for the user instead of retrying. */
export class HeldError extends Error {
  constructor(
    readonly reason: HeldState["reason"],
    message: string,
    readonly details: Pick<HeldState, "savedUpdatedAt" | "conflict"> = {},
  ) {
    super(message);
  }
}

/** Whether Edit is safe: only when no upload of this capture can have reached a server. */
export function canEditHeld(item: OutboxItem): boolean {
  return !item.held || (item.held.reason === "unsupported" && !item.uploadStarted);
}

const RETRY_EVERY_MS = 30_000;

/** Offline, signed out, rate limited, or a server hiccup: worth trying again later. */
function worthRetrying(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/** Older versions stored items without keywords (or other fields): read them as an empty keyword list. */
export function normalizeItem(raw: unknown): OutboxItem | null {
  const item = raw as Partial<OutboxItem> | null;
  if (!item || typeof item.clientId !== "string") return null;
  const normalized: OutboxItem = {
    ...item,
    clientId: item.clientId,
    body: typeof item.body === "string" ? item.body : "",
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    photos: Array.isArray(item.photos) ? item.photos : [],
  };
  // A missing list stays missing (it reads as empty everywhere); a malformed one keeps only its text entries.
  if (item.customKeywords !== undefined) {
    normalized.customKeywords = Array.isArray(item.customKeywords)
      ? item.customKeywords.filter((value) => typeof value === "string")
      : [];
  }
  return normalized;
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
    private readonly send: SendCapture,
    private readonly reconcile: ReconcileCapture = send,
  ) {
    this.ready = storage
      .all()
      .then((items) => {
        this.items = items
          .map(normalizeItem)
          .filter((item): item is OutboxItem => item !== null)
          .sort((a, b) => a.createdAt - b.createdAt);
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
      await this.send(item, async () => {});
      this.sentListeners.forEach((listener) => listener());
      return "sent";
    }
    this.items = [...this.items, item];
    this.notify();
    await this.flush();
    const stored = this.items.find((entry) => entry.clientId === item.clientId);
    return !stored ? "sent" : stored.held ? "held" : stored.error ? "rejected" : "queued";
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

  /**
   * User-started reconciliation of a held item against its original clientId. Success removes it; anything else
   * keeps all of its content held with an explanation. Never runs automatically.
   */
  async recover(clientId: string, resolution?: Resolution): Promise<RecoverResult> {
    await this.ready;
    const item = this.find(clientId);
    if (!item?.held) return "held";
    try {
      await this.reconcile(item, this.markUploadStarted(clientId), resolution);
    } catch (error) {
      const latest = this.find(clientId) ?? item;
      await this.replace({ ...latest, held: heldState(latest, error) });
      return "held";
    }
    await this.discard(clientId);
    this.sentListeners.forEach((listener) => listener());
    return "recovered";
  }

  private find(clientId: string): OutboxItem | undefined {
    return this.items.find((entry) => entry.clientId === clientId);
  }

  /** Durably records that a create request is about to leave, before it does. */
  private markUploadStarted(clientId: string): () => Promise<void> {
    return async () => {
      const current = this.find(clientId);
      if (current && !current.uploadStarted) await this.replace({ ...current, uploadStarted: true });
    };
  }

  private async replace(item: OutboxItem): Promise<void> {
    await this.storage.put(item).catch(() => {});
    this.items = this.items.map((entry) => (entry.clientId === item.clientId ? item : entry));
    this.notify();
  }

  private async run(): Promise<void> {
    await this.ready;
    const tried = new Set<string>();
    for (;;) {
      // Re-read each time: memories saved while this runs go out in the same pass. Held items wait for the user.
      const item = this.items.find((entry) => !entry.error && !entry.held && !tried.has(entry.clientId));
      if (!item) return;
      tried.add(item.clientId);
      const earlierAttempt = item.uploadStarted === true;
      try {
        await this.send(item, this.markUploadStarted(item.clientId));
      } catch (error) {
        const latest = this.find(item.clientId) ?? item;
        if (error instanceof HeldError) {
          await this.replace({ ...latest, held: heldState(latest, error) });
          continue;
        }
        if (worthRetrying(error)) return;
        if (earlierAttempt) {
          // An earlier attempt may have saved it: editing and saving again could duplicate it. Reconcile instead.
          const message = `${errorMessage(error)} An earlier upload may already have saved this memory; recover it to check.`;
          await this.replace({ ...latest, held: { ...heldState(latest, error), reason: "unverified", message } });
          continue;
        }
        await this.replace({ ...latest, error: errorMessage(error) });
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

/**
 * The held state after a failed send or recovery. A capture whose upload may have reached a server never becomes
 * "unsupported" (never uploaded): it stays reconcilable by its original clientId, keeping any earlier details.
 */
export function heldState(item: OutboxItem, error: unknown): HeldState {
  const previous = item.held;
  const keep = { savedUpdatedAt: previous?.savedUpdatedAt ?? null, conflict: previous?.conflict };
  const possiblyUploaded = item.uploadStarted === true;
  if (error instanceof HeldError) {
    if (error.reason === "unsupported" && possiblyUploaded) {
      return { ...keep, reason: previous?.reason === "conflict" ? "conflict" : "unverified", message: MAY_ALREADY_EXIST };
    }
    return {
      reason: error.reason,
      message: error.message,
      // A send always states its anchor (null for a retry's 200); other held errors keep the earlier one.
      savedUpdatedAt: "savedUpdatedAt" in error.details ? (error.details.savedUpdatedAt ?? null) : keep.savedUpdatedAt,
      conflict: error.reason === "conflict" ? error.details.conflict : undefined,
    };
  }
  const reason = !previous ? "unverified" : previous.reason === "unsupported" && possiblyUploaded ? "unverified" : previous.reason;
  return { ...keep, reason, message: `${errorMessage(error)} Nothing was lost; it's still kept on this phone.` };
}

/** Whether the server's saved keywords are the ones that were sent (missing fields count as not saved). */
export function savedKeywordsMatch(sent: readonly string[], saved: unknown): boolean {
  const list = (saved as { customKeywords?: unknown } | null)?.customKeywords;
  if (!Array.isArray(list) || !list.every((value) => typeof value === "string")) return false;
  try {
    return sameKeywordSet(normalizeKeywords(sent), list);
  } catch {
    return false;
  }
}

function containsKeywords(sent: readonly string[], saved: unknown): boolean {
  const list = (saved as { customKeywords?: unknown } | null)?.customKeywords;
  if (!Array.isArray(list)) return false;
  const keys = new Set(list.filter((value): value is string => typeof value === "string").map(keywordKey));
  return sent.every((keyword) => keys.has(keywordKey(keyword)));
}

async function requireKeywordCapture(): Promise<void> {
  // Offline or signed out throws an ApiError, which leaves the item queued for a normal retry.
  const me = await getMe();
  if (!Array.isArray(me?.capabilities) || !me.capabilities.includes(KEYWORD_CAPTURE_CAPABILITY)) {
    throw new HeldError(
      "unsupported",
      "This Recall server can't save keywords yet, so nothing was uploaded. Try again after it's updated, or edit the memory.",
    );
  }
}

/** Uploads one capture with its keywords, confirming the server really saved them. */
export async function sendCapture(item: OutboxItem, onUpload: () => Promise<void> = async () => {}): Promise<void> {
  const keywords = item.customKeywords ?? [];
  if (keywords.length > 0) await requireKeywordCapture();
  await onUpload();
  const { status, data: saved } = await createMemory({
    body: item.body,
    photos: item.photos,
    clientId: item.clientId,
    createdAt: item.createdAt,
    customKeywords: keywords,
  });
  if (keywords.length > 0 && !savedKeywordsMatch(keywords, saved)) {
    throw new HeldError(
      "unverified",
      "Recall answered, but couldn't confirm this memory's keywords were saved. Recover them when you're ready.",
      { savedUpdatedAt: captureTimeUpdatedAt(status, saved) },
    );
  }
}

/**
 * The recall's updatedAt as of its creation, or null when unknown. Only a 201 Created response is created by this very
 * request; a 200 answers a retry with the current record, which may include later edits (e.g. a keyword added and then
 * removed), so its updatedAt can never prove that the recall is untouched since the capture.
 */
export function captureTimeUpdatedAt(status: number, saved: unknown): number | null {
  const updatedAt = (saved as { updatedAt?: unknown } | null)?.updatedAt;
  return status === 201 && typeof updatedAt === "number" ? updatedAt : null;
}

/**
 * Reconciles a held capture by its original clientId, without creating a second recall. Only a server answer of
 * `missing` leads to an upload (with the same clientId). A `conflict` is held for the user's explicit choice.
 */
export async function reconcileCapture(
  item: OutboxItem,
  onUpload: () => Promise<void> = async () => {},
  resolution?: Resolution,
): Promise<void> {
  const keywords = item.customKeywords ?? [];
  await requireKeywordCapture();
  const result = await reconcileMemory({
    clientId: item.clientId,
    customKeywords: keywords,
    expectedUpdatedAt: resolution === "add" ? (item.held?.conflict?.updatedAt ?? null) : (item.held?.savedUpdatedAt ?? null),
    resolution: resolution ?? null,
  });
  switch (result?.status) {
    case "missing":
      if (resolution === "keep") {
        throw new HeldError("unverified", "Recall no longer has this memory. Recover it to upload it again, or discard it.");
      }
      return sendCapture(item, onUpload);
    case "already-saved":
    case "kept":
      return;
    case "reconciled":
      if (containsKeywords(keywords, result.memory)) return;
      break;
    case "conflict": {
      const memory = result.memory;
      if (memory && typeof memory.updatedAt === "number") {
        throw new HeldError(
          "conflict",
          "Recall's copy of this memory changed after it was saved without these keywords. Add the missing keywords, or keep Recall's version.",
          {
            conflict: {
              keywords: Array.isArray(memory.customKeywords) ? memory.customKeywords : [],
              missing: Array.isArray(result.missingKeywords) ? result.missingKeywords : keywords,
              updatedAt: memory.updatedAt,
            },
          },
        );
      }
      break;
    }
  }
  throw new HeldError("unverified", "Recall still couldn't confirm these keywords. Nothing was changed on this phone.");
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
  shared ??= new Outbox(indexedDbStorage(), sendCapture, reconcileCapture);
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
      if (outbox.snapshot().some((item) => !item.error && !item.held)) flush();
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
