import { normalizeIdentity } from "./identity";

export { normalizeIdentity } from "./identity";

export interface FingerprintBook { book_id: string; title: string | null; author: string | null }
export interface FingerprintInput { book_id?: string | null; fingerprint?: string | null }
export interface LibraryMatcher { match(input: FingerprintInput): string | null }
const FINGERPRINT = /^[a-f0-9]{64}$/;
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
/** Lowercase hex SHA-256 of the normalized title and author; an untitled book has no identity. */
export async function bookFingerprint(title: string | null, author: string | null): Promise<string | null> {
  const normalizedTitle = normalizeIdentity(title);
  if (!normalizedTitle) return null;
  const data = new TextEncoder().encode(`${normalizedTitle}\u0000${normalizeIdentity(author)}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
export const isBookFingerprint = (value: unknown): value is string => typeof value === "string" && FINGERPRINT.test(value);
const matchers = new WeakMap<readonly FingerprintBook[], Promise<LibraryMatcher>>();

/** Book ids win; a fingerprint shared by several books is ambiguous and never guessed. */
export function createLibraryMatcher(books: readonly FingerprintBook[]): Promise<LibraryMatcher> {
  const cached = matchers.get(books);
  if (cached) return cached;
  const matcher = buildMatcher(books);
  matchers.set(books, matcher);
  return matcher;
}
async function buildMatcher(books: readonly FingerprintBook[]): Promise<LibraryMatcher> {
  const ids = new Set(books.map(book => book.book_id)), groups = new Map<string, Set<string>>();
  await Promise.all(books.map(async book => {
    const fingerprint = await bookFingerprint(book.title, book.author);
    if (!fingerprint) return;
    const group = groups.get(fingerprint);
    if (group) group.add(book.book_id); else groups.set(fingerprint, new Set([book.book_id]));
  }));
  const unique = new Map<string, string>();
  for (const [fingerprint, group] of groups) if (group.size === 1) unique.set(fingerprint, [...group][0]!);
  return {
    match({ book_id, fingerprint }) {
      if (book_id && ids.has(book_id)) return book_id;
      return fingerprint && FINGERPRINT.test(fingerprint) ? unique.get(fingerprint) ?? null : null;
    },
  };
}
