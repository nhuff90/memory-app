import { createStore, del, set, values, type UseStore } from "idb-keyval";
import type { PhotoBlobs } from "../api";

/** The draft text key predates keywords; older versions read only this, which keeps working. */
export const DRAFT_TEXT_KEY = "recall:draft";
const DRAFT_KEYWORDS_KEY = "recall:draft-keywords";

export interface DraftKeywords {
  keywords: string[];
  /** Unfinished text in the keyword input. */
  input: string;
}

export interface StoredDraftPhoto extends PhotoBlobs {
  key: string;
  addedAt: number;
}

/** Drafts saved by older versions have no keyword entry: an empty keyword list. */
export function loadDraftKeywords(): DraftKeywords {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEYWORDS_KEY) ?? "null") as Partial<DraftKeywords> | null;
    return {
      keywords: Array.isArray(raw?.keywords) ? raw.keywords.filter((value): value is string => typeof value === "string") : [],
      input: typeof raw?.input === "string" ? raw.input : "",
    };
  } catch {
    return { keywords: [], input: "" };
  }
}

export function saveDraftKeywords(draft: DraftKeywords): void {
  try {
    if (draft.keywords.length === 0 && !draft.input) localStorage.removeItem(DRAFT_KEYWORDS_KEY);
    else localStorage.setItem(DRAFT_KEYWORDS_KEY, JSON.stringify(draft));
  } catch {
    // Private mode or full storage: the draft still lives in memory.
  }
}

let store: UseStore | null = null;
// A separate database: adding a store to the existing "recall" database would need a version upgrade.
const photoStore = () => (store ??= createStore("recall-draft", "photos"));

/** Photos added to the draft survive reloads until the memory is saved or they are removed. */
export async function loadDraftPhotos(): Promise<StoredDraftPhoto[]> {
  try {
    const photos = await values<StoredDraftPhoto>(photoStore());
    return photos
      .filter((photo) => photo && typeof photo.key === "string" && photo.full instanceof Blob && photo.thumb instanceof Blob)
      .sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

export async function putDraftPhoto(photo: StoredDraftPhoto): Promise<void> {
  await set(photo.key, photo, photoStore()).catch(() => {});
}

export async function removeDraftPhoto(key: string): Promise<void> {
  await del(key, photoStore()).catch(() => {});
}
