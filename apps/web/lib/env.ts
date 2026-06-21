/**
 * Public runtime config. `NEXT_PUBLIC_API_BASE_URL` is inlined at build time by
 * Next; we read it through one accessor so a missing value fails loudly in one
 * place rather than producing `undefined/v1/...` URLs deep in the SDK.
 */
export function apiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) {
    // Sensible local default so a bare `next dev` works without an .env file.
    return "http://localhost:8080";
  }
  return url.replace(/\/+$/, "");
}
