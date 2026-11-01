export const CATEGORIES = ["people", "things", "work", "hobbies", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  people: "People",
  things: "Things",
  work: "Work",
  hobbies: "Hobbies",
  other: "Other",
};

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export interface Photo {
  id: number;
  /** What Claude saw in the photo, when photo descriptions are turned on. */
  caption: string | null;
  createdAt: number;
}

export interface Memory {
  id: number;
  body: string;
  category: Category | null;
  categorySetByUser: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Set when the memory is marked Outdated: kept, but hidden from search. */
  archivedAt: number | null;
  enrichedAt: number | null;
  photos: Photo[];
}

export interface MemoryList {
  memories: Memory[];
  nextCursor: string | null;
}

export interface SearchResponse {
  results: Memory[];
}

export interface AskResponse {
  answer: string;
  /** The answer again. Every reply Siri Shortcuts get, errors included, has a `message` to read aloud. */
  message: string;
  usedIds: number[];
  results: Memory[];
}

export interface MeResponse {
  aiEnabled: boolean;
  model: string | null;
  photoCaptions: boolean;
  counts: { memories: number; photos: number };
}

export interface UsageSummary {
  month: string;
  asks: number;
  enrichments: number;
  captions: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model's price is unknown. */
  estimatedCostUsd: number | null;
}

export interface ApiToken {
  id: number;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreatedApiToken extends ApiToken {
  /** Shown once, at creation. Only a hash is stored. */
  token: string;
}

export interface CaptureResponse {
  id: number;
  message: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export function photoUrl(photoId: number, size: "full" | "thumb" = "full"): string {
  return size === "thumb" ? `/api/photos/${photoId}?size=thumb` : `/api/photos/${photoId}`;
}
