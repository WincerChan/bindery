/** ZIP paths are names, not URLs. Encode punctuation per segment as well. */
export function encodeEpubPath(path: string): string {
  return path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

const absolutePath = (path: string) => path.startsWith("/") || /^[a-z]:\//i.test(path);

export function isSafeEpubPath(path: string): boolean {
  return !!path && !absolutePath(path) && !/[\\\p{Cc}]/u.test(path)
    && path.split("/").every(part => !!part && part !== "." && part !== "..");
}

function relativePath(from: string, reference: string): string | null {
  if (absolutePath(reference) || /[\\\p{Cc}]/u.test(reference)) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of reference.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  const path = parts.join("/");
  return isSafeEpubPath(path) ? path : null;
}

/** Decode once; exact membership disambiguates literal #/? in producer names. */
export function resolveEpubReference(from: string, raw: string, has: (path: string) => boolean): { path: string; fragment: string } | null {
  const locate = (value: string) => {
    let decoded = value;
    try { decoded = value.split("/").map(part => {
      const result = decodeURIComponent(part);
      if (result.includes("/")) throw new Error("Encoded separator");
      return result;
    }).join("/"); } catch { /* Some producers use literal percent signs. */ }
    for (const candidate of new Set([decoded, value])) {
      const path = relativePath(from, candidate);
      if (path && has(path)) return path;
    }
    return null;
  };
  if (!raw || raw.startsWith("#")) return has(from) ? { path: from, fragment: raw.slice(1) } : null;
  const whole = locate(raw);
  if (whole) return { path: whole, fragment: "" };
  const hash = raw.indexOf("#"), fragment = hash < 0 ? "" : raw.slice(hash + 1);
  const withoutHash = hash < 0 ? raw : raw.slice(0, hash);
  const path = locate(withoutHash) ?? locate(withoutHash.split("?")[0]);
  return path ? { path, fragment } : null;
}
