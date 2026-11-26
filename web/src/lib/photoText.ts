import { PHOTO_TEXT_CAPABILITY } from "../../../shared/types";

/** Longest note the editor accepts, matching the server's limit on a memory's body. */
export const MAX_NOTE_LENGTH = 10_000;

export type AddTextToNoteResult = { ok: true; body: string } | { ok: false; message: string };

/**
 * The note with a photo's text added at the end, for "Add to note". The result goes into the editor, so it is saved
 * or discarded like any other edit. An empty note becomes the text; otherwise the text follows a blank line. Refused
 * when the note already contains the text, or when the result would be longer than `maxLength`.
 */
export function addTextToNote(body: string, text: string, maxLength = MAX_NOTE_LENGTH): AddTextToNoteResult {
  if (body.includes(text.trim())) return { ok: false, message: "This text is already in the note." };
  const next = body.trim() ? `${body.trimEnd()}\n\n${text}` : text;
  if (next.length > maxLength) {
    return { ok: false, message: `Adding this text would make the note longer than ${maxLength.toLocaleString("en-US")} characters.` };
  }
  return { ok: true, body: next };
}

/** Whether a `/api/me` response advertises photo text. Older servers and malformed responses do not. */
export function supportsPhotoText(me: unknown): boolean {
  const capabilities = (me as { capabilities?: unknown } | null | undefined)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(PHOTO_TEXT_CAPABILITY);
}

export interface PhotoTextStatus {
  /** Described photos whose text has never been read. */
  unread: number;
  /** Whether the user asked to read the text in saved photos. */
  requested: boolean;
  /** Asked, Describe photos is on, and photos are still unread: the server is reading them. */
  reading: boolean;
  /** Asked and photos are still unread, but Describe photos is off, so nothing is being read. */
  paused: boolean;
}

/**
 * Reading the text in saved photos, from a `/api/me` response. Null when the server does not advertise photo text,
 * or when `photoText` is missing or malformed, so the screen offers nothing.
 */
export function photoTextStatus(me: unknown): PhotoTextStatus | null {
  if (!supportsPhotoText(me)) return null;
  const { photoText, photoCaptions } = me as { photoText?: unknown; photoCaptions?: unknown };
  if (!photoText || typeof photoText !== "object") return null;
  const { unread, requested } = photoText as { unread?: unknown; requested?: unknown };
  if (typeof unread !== "number" || !Number.isInteger(unread) || unread < 0 || typeof requested !== "boolean") return null;
  const pending = requested && unread > 0;
  return { unread, requested, reading: pending && photoCaptions === true, paused: pending && photoCaptions !== true };
}
