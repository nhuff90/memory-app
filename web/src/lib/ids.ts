/** A random id for de-duplicating saves. Uses getRandomValues, which (unlike randomUUID) also works over plain http. */
export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
