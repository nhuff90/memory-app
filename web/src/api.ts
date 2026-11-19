import type {
  ApiErrorBody,
  ApiToken,
  AskResponse,
  Category,
  CreatedApiToken,
  MeResponse,
  Memory,
  MemoryList,
  ReconcileResponse,
  SearchResponse,
  UsageSummary,
} from "../../shared/types";

/**
 * Older servers return memories without newer fields (pins, custom keywords). Fill safe defaults so the UI never
 * crashes on an older response shape.
 */
export function normalizeMemory(raw: Memory): Memory {
  const memory = (raw ?? {}) as Partial<Memory>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  return {
    ...(memory as Memory),
    body: typeof memory.body === "string" ? memory.body : "",
    category: memory.category ?? null,
    categorySetByUser: memory.categorySetByUser === true,
    tags: strings(memory.tags),
    pinned: memory.pinned === true,
    customKeywords: strings(memory.customKeywords),
    archivedAt: typeof memory.archivedAt === "number" ? memory.archivedAt : null,
    enrichedAt: typeof memory.enrichedAt === "number" ? memory.enrichedAt : null,
    photos: Array.isArray(memory.photos) ? memory.photos : [],
  };
}

const normalizeList = (list: unknown): Memory[] => (Array.isArray(list) ? list.map(normalizeMemory) : []);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let unauthorizedHandler: () => void = () => {};

/** Called whenever the server says the session is gone, so the app can show the login screen. */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await apiWithStatus<T>(path, options)).data;
}

/** Like `api`, also returning the HTTP status (for example 201 Created versus 200 for an idempotent retry). */
export async function apiWithStatus<T>(path: string, options: RequestOptions = {}): Promise<{ status: number; data: T }> {
  const { json, ...init } = options;
  const headers = new Headers(init.headers);
  let body = init.body;
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "offline", "Can't reach Recall right now. Check your connection.");
  }
  if (response.status === 401 && path !== "/api/login") unauthorizedHandler();
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    throw new ApiError(response.status, data?.error ?? "error", data?.message ?? "Something went wrong. Please try again.");
  }
  if (response.status === 204) return { status: 204, data: undefined as T };
  return { status: response.status, data: (await response.json()) as T };
}

export interface PhotoBlobs {
  full: Blob;
  thumb: Blob;
}

function appendPhotos(form: FormData, photos: PhotoBlobs[]): void {
  for (const photo of photos) {
    form.append("photos", photo.full, "photo.jpg");
    form.append("thumbs", photo.thumb, "thumb.jpg");
  }
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const getMe = () => api<MeResponse>("/api/me");

export const askQuestion = async (question: string, signal?: AbortSignal) => {
  const response = await api<AskResponse>("/api/ask", { method: "POST", json: { question, timeZone: browserTimeZone() }, signal });
  return { ...response, usedIds: Array.isArray(response.usedIds) ? response.usedIds : [], results: normalizeList(response.results) };
};

export const getKeywords = (signal?: AbortSignal) => api<unknown>("/api/keywords", { signal });

export const reconcileMemory = (input: {
  clientId: string;
  customKeywords: string[];
  expectedUpdatedAt?: number | null;
  resolution?: "add" | "keep" | null;
}) =>
  api<ReconcileResponse | null>("/api/memories/reconcile", { method: "POST", json: input });

export const getUsage = () => api<UsageSummary>(`/api/usage?tz=${encodeURIComponent(browserTimeZone())}`);

export const updateSettings = (settings: { photoCaptions: boolean }) =>
  api<MeResponse>("/api/settings", { method: "PATCH", json: settings });

export const listTokens = () => api<{ tokens: ApiToken[] }>("/api/tokens");

export const createToken = (name: string) =>
  api<CreatedApiToken>("/api/tokens", { method: "POST", json: { name, timeZone: browserTimeZone() } });

export const revokeToken = (id: number) => api<void>(`/api/tokens/${id}`, { method: "DELETE" });

export const login = (password: string) => api<{ ok: true }>("/api/login", { method: "POST", json: { password } });

export const logout = () => api<{ ok: true }>("/api/logout", { method: "POST" });

export async function listMemories(
  options: {
    cursor?: string | null;
    limit?: number;
    archived?: boolean;
    category?: Category | null;
    photos?: boolean;
    pinned?: boolean;
    keyword?: string | null;
  } = {},
): Promise<MemoryList> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.archived) params.set("archived", "1");
  if (options.category) params.set("category", options.category);
  if (options.photos) params.set("photos", "1");
  if (options.pinned) params.set("pinned", "1");
  if (options.keyword) params.set("keyword", options.keyword);
  const page = await api<MemoryList>(`/api/memories?${params}`);
  return { memories: normalizeList(page?.memories), nextCursor: typeof page?.nextCursor === "string" ? page.nextCursor : null };
}

export async function searchMemories(
  query: string,
  options: {
    archived?: boolean;
    strict?: boolean;
    limit?: number;
    category?: Category | null;
    pinned?: boolean;
    keyword?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (options.archived) params.set("archived", "1");
  if (options.category) params.set("category", options.category);
  if (options.strict) params.set("strict", "1");
  if (options.pinned) params.set("pinned", "1");
  if (options.keyword) params.set("keyword", options.keyword);
  if (options.limit) params.set("limit", String(options.limit));
  const response = await api<SearchResponse>(`/api/search?${params}`, { signal: options.signal });
  return { results: normalizeList(response?.results) };
}

/**
 * Body, photos and keywords go up together in one request. The raw response is returned unnormalized so the outbox
 * can tell an older server (which drops `customKeywords`) from a real save, with its status: 201 means this request
 * created the recall; 200 means an earlier attempt had (the record may have been edited since).
 */
export function createMemory(input: { body: string; photos: PhotoBlobs[]; clientId: string; createdAt?: number; customKeywords?: string[] }) {
  const form = new FormData();
  form.set("body", input.body);
  form.set("clientId", input.clientId);
  if (input.createdAt) form.set("createdAt", String(input.createdAt));
  for (const keyword of input.customKeywords ?? []) form.append("customKeywords", keyword);
  appendPhotos(form, input.photos);
  return apiWithStatus<unknown>("/api/memories", { method: "POST", body: form });
}

export const relatedMemories = async (id: number, signal?: AbortSignal): Promise<SearchResponse> => {
  const response = await api<SearchResponse>(`/api/memories/${id}/related`, { signal });
  return { results: normalizeList(response?.results) };
};

export const updateMemory = async (id: number, patch: { body?: string; archived?: boolean; category?: Category; pinned?: boolean; customKeywords?: string[] }) =>
  normalizeMemory(await api<Memory>(`/api/memories/${id}`, { method: "PATCH", json: patch }));

export const deleteMemory = (id: number) => api<void>(`/api/memories/${id}`, { method: "DELETE" });

export async function addPhotos(id: number, photos: PhotoBlobs[]) {
  const form = new FormData();
  appendPhotos(form, photos);
  return normalizeMemory(await api<Memory>(`/api/memories/${id}/photos`, { method: "POST", body: form }));
}

export const deletePhoto = async (photoId: number) => normalizeMemory(await api<Memory>(`/api/photos/${photoId}`, { method: "DELETE" }));

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
