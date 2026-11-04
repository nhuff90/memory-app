import type {
  ApiErrorBody,
  ApiToken,
  AskResponse,
  Category,
  CreatedApiToken,
  MeResponse,
  Memory,
  MemoryList,
  SearchResponse,
  UsageSummary,
} from "../../shared/types";

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
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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

export const askQuestion = (question: string, signal?: AbortSignal) =>
  api<AskResponse>("/api/ask", { method: "POST", json: { question, timeZone: browserTimeZone() }, signal });

export const getUsage = () => api<UsageSummary>(`/api/usage?tz=${encodeURIComponent(browserTimeZone())}`);

export const updateSettings = (settings: { photoCaptions: boolean }) =>
  api<MeResponse>("/api/settings", { method: "PATCH", json: settings });

export const listTokens = () => api<{ tokens: ApiToken[] }>("/api/tokens");

export const createToken = (name: string) =>
  api<CreatedApiToken>("/api/tokens", { method: "POST", json: { name, timeZone: browserTimeZone() } });

export const revokeToken = (id: number) => api<void>(`/api/tokens/${id}`, { method: "DELETE" });

export const login = (password: string) => api<{ ok: true }>("/api/login", { method: "POST", json: { password } });

export const logout = () => api<{ ok: true }>("/api/logout", { method: "POST" });

export function listMemories(
  options: { cursor?: string | null; limit?: number; archived?: boolean; category?: Category | null; photos?: boolean; pinned?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.archived) params.set("archived", "1");
  if (options.category) params.set("category", options.category);
  if (options.photos) params.set("photos", "1");
  if (options.pinned) params.set("pinned", "1");
  return api<MemoryList>(`/api/memories?${params}`);
}

export function searchMemories(
  query: string,
  options: { archived?: boolean; strict?: boolean; limit?: number; category?: Category | null; pinned?: boolean; signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams({ q: query });
  if (options.archived) params.set("archived", "1");
  if (options.category) params.set("category", options.category);
  if (options.strict) params.set("strict", "1");
  if (options.pinned) params.set("pinned", "1");
  if (options.limit) params.set("limit", String(options.limit));
  return api<SearchResponse>(`/api/search?${params}`, { signal: options.signal });
}

export function createMemory(input: { body: string; photos: PhotoBlobs[]; clientId: string; createdAt?: number }) {
  const form = new FormData();
  form.set("body", input.body);
  form.set("clientId", input.clientId);
  if (input.createdAt) form.set("createdAt", String(input.createdAt));
  appendPhotos(form, input.photos);
  return api<Memory>("/api/memories", { method: "POST", body: form });
}

export const relatedMemories = (id: number, signal?: AbortSignal) =>
  api<SearchResponse>(`/api/memories/${id}/related`, { signal });

export const updateMemory = (id: number, patch: { body?: string; archived?: boolean; category?: Category; pinned?: boolean; customKeywords?: string[] }) =>
  api<Memory>(`/api/memories/${id}`, { method: "PATCH", json: patch });

export const deleteMemory = (id: number) => api<void>(`/api/memories/${id}`, { method: "DELETE" });

export function addPhotos(id: number, photos: PhotoBlobs[]) {
  const form = new FormData();
  appendPhotos(form, photos);
  return api<Memory>(`/api/memories/${id}/photos`, { method: "POST", body: form });
}

export const deletePhoto = (photoId: number) => api<Memory>(`/api/photos/${photoId}`, { method: "DELETE" });

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
