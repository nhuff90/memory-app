export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503;

/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

export function notFound(message = "That memory no longer exists."): HttpError {
  return new HttpError(404, "not_found", message);
}

export function tooLarge(message: string): HttpError {
  return new HttpError(413, "too_large", message);
}
