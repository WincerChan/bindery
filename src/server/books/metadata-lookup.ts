import { quoteComponent } from "../../features/books/navigation";
import {
  parse,
  parseFragment,
  serializeOuter,
  type DefaultTreeAdapterMap,
} from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface LookupMetadata {
  source: string;
  title: string | null;
  author: string | null;
  language: string | null;
  description: string | null;
  publisher: string | null;
  tags: string[];
  published: string | null;
  isbn: string | null;
  cover_url: string | null;
}
export interface LookupAttempt {
  source: string;
  ok: boolean;
  title: string | null;
  score: number;
  error: string | null;
  selected: boolean;
}
export function lookupMetadata(
  source: string,
  values: Partial<LookupMetadata> = {},
): LookupMetadata {
  return {
    source,
    title: null,
    author: null,
    language: null,
    description: null,
    publisher: null,
    tags: [],
    published: null,
    isbn: null,
    cover_url: null,
    ...values,
  };
}
function textContent(node: HtmlNode): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}
function unescape(raw: string) {
  return textContent(parseFragment(raw.replaceAll("<", "&lt;")));
}
export function cleanText(raw: unknown): string | null {
  return typeof raw === "string"
    ? unescape(raw)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/gu, " ")
        .trim() || null
    : null;
}
const cleanDate = (raw: unknown) => {
  const text = cleanText(raw);
  return text?.match(/\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?/)?.[0] || text;
};
const cleanIsbn = (raw: unknown) => {
  const text = cleanText(raw);
  return text?.match(/[0-9Xx-]{10,20}/)?.[0].toUpperCase() || text;
};
const cleanUrl = (raw: unknown) => {
  let url = typeof raw === "string" ? unescape(raw).trim() : "";
  if (url.startsWith("//")) url = `https:${url}`;
  return /^https?:\/\//i.test(url) ? url : null;
};
const unique = (items: (string | null)[]) => [
  ...new Set(items.filter((x): x is string => Boolean(x))),
];
const splitTags = (raw: unknown) =>
  unique((cleanText(raw) || "").split(/[，,;/|]/).map(cleanText));
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pickAuthor(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value))
    return value.map(pickAuthor).filter(Boolean).join(", ") || null;
  return cleanText(record(value).name);
}
function pickDescription(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value))
    return value.map(pickDescription).filter(Boolean).join("\n") || null;
  const obj = record(value);
  return (
    cleanText(obj["@value"]) || cleanText(obj.value) || cleanText(obj.text)
  );
}
function pickImage(value: unknown): string | null {
  if (typeof value === "string") return cleanUrl(value);
  if (Array.isArray(value)) return value.map(pickImage).find(Boolean) || null;
  const obj = record(value);
  return cleanUrl(obj.url) || cleanUrl(obj.contentUrl) || cleanUrl(obj["@id"]);
}
function ldObjects(html: string): Record<string, unknown>[] {
  return [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis,
    ),
  ].flatMap((match) => {
    try {
      const value: unknown = JSON.parse(unescape(match[1].trim()));
      return (Array.isArray(value) ? value : [value]).filter(
        (x) => x && typeof x === "object" && !Array.isArray(x),
      );
    } catch {
      return [];
    }
  });
}
function elements(html: string): Element[] {
  // Remote pages are HTML, including optional end tags that an XML parser rejects.
  const found: Element[] = [], pending: HtmlNode[] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        pending.push(node.childNodes[i]);
  }
  return found;
}
function attribute(node: Element, name: string): string | null {
  return node.attrs.find(attr => attr.name === name)?.value ?? null;
}
function hasClass(node: Element, name: string): boolean {
  return (attribute(node, "class") || "").split(/\s+/u).includes(name);
}
function hasAncestor(node: Element, matches: (parent: Element) => boolean): boolean {
  for (let parent = node.parentNode; parent; parent = "parentNode" in parent ? parent.parentNode : null)
    if ("tagName" in parent && matches(parent)) return true;
  return false;
}
function within(node: Element, id: string): boolean {
  return hasAncestor(node, parent => attribute(parent, "id") === id);
}
function metaContent(html: string, attr: string, key: string): string | null {
  // Preserve the reference's attribute-order-dependent fallback.
  return (
    html.match(
      new RegExp(
        `<meta[^>]+${attr}=["']${key}["'][^>]+content=["'](.*?)["'][^>]*>`,
        "is",
      ),
    )?.[1] || null
  );
}
export function htmlFragmentToMarkdownish(html: string): string | null {
  return (
    unescape(
      html
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*li[^>]*>/gi, "- ")
        .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n\n")
        .replace(/<[^>]+>/g, ""),
    )
      .replaceAll("\r\n", "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim() || null
  );
}
function applyLd(
  meta: LookupMetadata,
  obj: Record<string, unknown>,
  publisherKey: string,
): void {
  meta.title = cleanText(obj.name) || meta.title;
  meta.author = pickAuthor(obj.author) || meta.author;
  meta.description = pickDescription(obj.description) || meta.description;
  meta.publisher = cleanText(record(obj[publisherKey]).name) || meta.publisher;
  meta.published = cleanDate(obj.datePublished) || meta.published;
  meta.isbn = cleanIsbn(obj.isbn) || meta.isbn;
  meta.language = cleanText(obj.inLanguage) || meta.language;
}
export function parseDoubanSubjectHtml(html: string): LookupMetadata {
  const meta = lookupMetadata("douban");
  let keywords: string[] = [];
  for (const obj of ldObjects(html)) {
    if (
      !(Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]]).includes(
        "Book",
      )
    )
      continue;
    applyLd(meta, obj, "publisher");
    meta.cover_url = pickImage(obj.image);
    keywords = splitTags(obj.keywords);
    break;
  }
  const intros = elements(html).filter(
    (n) =>
      n.tagName.toLowerCase() === "div" &&
      hasClass(n, "intro") &&
      within(n, "link-report"),
  );
  const intro = intros.find(n => hasAncestor(n, parent => hasClass(parent, "all"))) || intros.at(-1);
  if (intro)
    meta.description = htmlFragmentToMarkdownish(serializeOuter(intro)) || meta.description;
  let nbgCover: string | null = null;
  for (const match of html.matchAll(/<a\b([^>]*)>/gis)) {
    const cls = match[1].match(/class=["']([^"']*)["']/is)?.[1];
    if (!/(^|\s)nbg(\s|$)/i.test(cleanText(cls) || "")) continue;
    const href = cleanUrl(match[1].match(/href=["'](.*?)["']/is)?.[1]);
    if (href) {
      nbgCover = href;
      break;
    }
  }
  // nbg outranks both JSON-LD and OpenGraph.
  meta.cover_url =
    nbgCover ||
    cleanUrl(metaContent(html, "property", "og:image")) ||
    meta.cover_url;
  const links = unique(
    [
      ...html.matchAll(
        /<a[^>]*class=["'][^"']*\btag\b[^"']*["'][^>]*>(.*?)<\/a>/gis,
      ),
    ].map((m) => cleanText(m[1])),
  );
  const criteria = unescape(
    html.match(/criteria\s*=\s*(["'])(.*?)\1/is)?.[2] || "",
  );
  const criteriaTags = unique(
    criteria
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("7:"))
      .map((s) => cleanText(s.slice(2).trim())),
  );
  meta.tags = links.length
    ? links
    : criteriaTags.length
      ? criteriaTags
      : keywords;
  meta.description ||= cleanText(metaContent(html, "property", "og:description"));
  const description = cleanText(metaContent(html, "name", "description"));
  if (!meta.description && description && !/^图书.*介绍、书评、论坛及推荐$/u.test(description))
    meta.description = description;
  const text = cleanText(html) || "";
  meta.publisher ||= cleanText(
    text.match(
      /出版社[:：]\s*(.+?)(?=\s+(?:作者|原作名|副标题|译者|出版年|页数|定价|装帧|丛书|ISBN|统一书号|出品方|品牌方)[:：]|$)/,
    )?.[1],
  );
  meta.isbn ||= cleanIsbn(text.match(/ISBN[:：]\s*([0-9Xx-]{10,20})/)?.[1]);
  meta.published ||= cleanDate(text.match(/出版年[:：]\s*([0-9-]{4,10})/)?.[1]);
  return meta;
}
function amazonRpi(html: string, key: string) {
  return cleanText(
    html.match(
      new RegExp(
        `<div[^>]+id=["']rpi-attribute-${key}["'][^>]*>.*?<div[^>]+rpi-attribute-value[^>]*>\\s*<span>(.*?)</span>`,
        "is",
      ),
    )?.[1],
  );
}
export function parseAmazonProductHtml(html: string): LookupMetadata {
  const meta = lookupMetadata("amazon");
  for (const obj of ldObjects(html)) {
    const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
    if (!types.includes("Book") && !types.includes("Product")) continue;
    applyLd(meta, obj, "brand");
    const tags = splitTags(obj.keywords);
    if (tags.length) meta.tags = tags;
    if (meta.title) break;
  }
  const rawTitle = cleanText(metaContent(html, "name", "title")) || "";
  meta.title ||=
    cleanText(
      html.match(/<span[^>]+id=["']productTitle["'][^>]*>(.*?)<\/span>/is)?.[1],
    ) ||
    cleanText(
      rawTitle.match(
        /Amazon\.com[:：]\s*(.+?)(?:\s*:\s*[0-9Xx-]{10,20}\b|$)/i,
      )?.[1],
    ) ||
    rawTitle ||
    null;
  const byline =
    html.match(/<div[^>]+id=["']bylineInfo["'][^>]*>(.*?)<\/div>/is)?.[1] || "";
  meta.author ||=
    unique(
      [...byline.matchAll(/<a[^>]*>(.*?)<\/a>/gis)].map((m) => cleanText(m[1])),
    ).join(", ") || null;
  if (!meta.description) {
    const all = elements(html),
      candidates: string[] = [];
    for (const group of [
      all.filter(
        (n) =>
          within(n, "bookDescription_feature_div") &&
          n.tagName.toLowerCase() === "span" &&
          hasClass(n, "a-expander-partial-collapse-content"),
      ),
      all.filter(
        (n) =>
          within(n, "bookDescription_feature_div") &&
          n.tagName.toLowerCase() === "div" &&
          hasClass(n, "a-expander-content"),
      ),
      all.filter((n) => attribute(n, "id") === "bookDescription_feature_div"),
    ])
      for (const node of group) {
        const text = cleanText(textContent(node));
        if (
          text &&
          [...text].length >= 40 &&
          !candidates.some((c) => c.toLowerCase() === text.toLowerCase())
        )
          candidates.push(text);
      }
    if (candidates.length)
      meta.description = candidates.sort(
        (a, b) => [...b].length - [...a].length,
      )[0];
    else {
      const bullets = unique(
        all
          .filter(
            (n) =>
              within(n, "feature-bullets") &&
              n.tagName.toLowerCase() === "span" &&
              hasClass(n, "a-list-item"),
          )
          .map((n) => cleanText(textContent(n)))
          .filter((t) => t && [...t].length >= 12),
      );
      meta.description =
        bullets
          .filter(
            (b, i) =>
              bullets.findIndex((c) => c.toLowerCase() === b.toLowerCase()) ===
              i,
          )
          .slice(0, 6)
          .map((t) => `- ${t}`)
          .join("\n") || null;
    }
  }
  meta.publisher ||= amazonRpi(html, "book_details-publisher");
  meta.published ||= cleanDate(
    amazonRpi(html, "book_details-publication_date"),
  );
  meta.language ||= cleanText(amazonRpi(html, "book_details-language"));
  meta.isbn ||=
    cleanIsbn(amazonRpi(html, "book_details-isbn13")) ||
    cleanIsbn(amazonRpi(html, "book_details-isbn10"));
  const text = cleanText(html) || "";
  meta.publisher ||= cleanText(
    text.match(/Publisher[:：]\s*([^\n\r]+?)\s{2,}/)?.[1],
  );
  meta.isbn ||= cleanIsbn(
    text.match(/ISBN-1[03][:：]\s*([0-9Xx-]{10,20})/)?.[1],
  );
  meta.published ||= cleanDate(
    text.match(/Publication date[:：]\s*([0-9A-Za-z,\- ]+)/)?.[1],
  );
  meta.language ||= cleanText(
    text.match(/Language[:：]\s*([A-Za-z\- ]+)/)?.[1],
  );
  const desc = cleanText(metaContent(html, "name", "description"));
  if (
    !meta.description &&
    desc &&
    !desc.toLowerCase().startsWith("amazon.com:")
  )
    meta.description = desc;
  return meta;
}
const normalize = (value: string | null) =>
  (cleanText(value) || "")
    .replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/g, "")
    .toLowerCase();
const authorWords = (value: string | null) =>
  new Set(
    (cleanText(value) || "")
      .toLowerCase()
      .match(/[0-9a-z]+|[\u4e00-\u9fff]+/g) || [],
  );
export function titleMatchScore(title: string | null, query: string): number {
  const target = normalize(query),
    value = normalize(title);
  if (!target || !value) return 0;
  if (value === target) return 4;
  if (value.includes(target) || target.includes(value)) return 3;
  const common = [...new Set(target)].filter((ch) => value.includes(ch)).length;
  return common >=
    Math.max(2, Math.floor(Math.min(target.length, value.length) / 2))
    ? 2
    : 0;
}
export function authorMatchScore(
  value: string | null,
  expected: string | null,
): number {
  const target = normalize(expected);
  if (!target) return 0;
  if (!cleanText(value)) return -1;
  const tokens = authorWords(expected);
  let best = -4;
  for (const candidate of (cleanText(value) || "")
    .split(/\s*(?:\/|,|，|;|；|&|＆|\||、)\s*/)
    .filter(Boolean)) {
    const normalized = normalize(candidate);
    if (!normalized) continue;
    if (normalized === target) return 8;
    if (normalized.includes(target) || target.includes(normalized)) {
      best = Math.max(best, 6);
      continue;
    }
    const words = authorWords(candidate),
      shared = [...tokens].filter((t) => words.has(t));
    if (tokens.size && words.size) {
      if (shared.length === tokens.size && shared.length === words.size)
        best = Math.max(best, 7);
      else if (
        shared.length &&
        (shared.length === tokens.size || shared.length === words.size)
      )
        best = Math.max(best, 5);
    }
  }
  return best;
}
export function metadataScore(
  item: LookupMetadata,
  query: string,
  author: string | null = null,
): number {
  const authorScore = authorMatchScore(item.author, author);
  return (
    titleMatchScore(item.title, query) * 3 +
    (author
      ? authorScore > 0
        ? authorScore
        : item.author
          ? -2
          : 0
      : item.author
        ? 2
        : 0) +
    (item.description ? 2 : 0) +
    (item.publisher ? 1 : 0) +
    (item.isbn ? 2 : 0) +
    (item.published ? 1 : 0) +
    (item.tags.length ? 1 : 0)
  );
}
export async function fetchText(
  url: string,
  timeout = 8,
  fetcher: Fetch = fetch,
  json = false,
): Promise<string> {
  const response = await fetcher(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: json
        ? "application/json,text/plain,*/*"
        : "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!response.ok)
    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
  const charset =
    response.headers
      .get("content-type")
      ?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || "utf-8";
  return new TextDecoder(charset).decode(await response.arrayBuffer());
}
export function mergeMetadata(
  primary: LookupMetadata,
  overlay: LookupMetadata,
): LookupMetadata {
  const result = { ...primary };
  for (const key of [
    "title",
    "author",
    "language",
    "description",
    "publisher",
    "published",
    "isbn",
    "cover_url",
  ] as const)
    result[key] = overlay[key] || primary[key];
  result.source = primary.source || overlay.source;
  result.tags = overlay.tags.length ? [...overlay.tags] : [...primary.tags];
  return result;
}
export async function lookupDouban(
  query: string,
  timeout = 8,
  author: string | null = null,
  fetcher: Fetch = fetch,
): Promise<LookupMetadata | null> {
  const data: unknown = JSON.parse(
    await fetchText(
      `https://book.douban.com/j/subject_suggest?q=${quoteComponent(query).replaceAll("%2F", "/")}`,
      timeout,
      fetcher,
      true,
    ),
  );
  if (!Array.isArray(data) || !data.length) return null;
  let best: Record<string, unknown> | undefined,
    bestRank: number[] | undefined,
    sawAuthor = false;
  const expected = cleanText(author);
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = record(raw),
      name = cleanText(String(item.author_name || ""));
    if (expected && name) sawAuthor = true;
    const score = expected ? authorMatchScore(name, expected) : 0,
      rank = [
        score > 0 ? 1 : 0,
        titleMatchScore(String(item.title || ""), query),
        score,
      ];
    if (
      !bestRank ||
      rank.some(
        (n, i) =>
          n > bestRank![i] &&
          rank.slice(0, i).every((v, j) => v === bestRank![j]),
      )
    ) {
      best = item;
      bestRank = rank;
    }
  }
  if (!best) return null;
  if (expected && sawAuthor && bestRank![0] === 0)
    throw new Error("未找到作者匹配的豆瓣条目");
  let meta = lookupMetadata("douban", {
    title: cleanText(String(best.title || "")),
    author: cleanText(String(best.author_name || "")),
    published: cleanDate(String(best.year || "")),
    cover_url: cleanUrl(String(best.img || best.cover || "")),
  });
  const id = String(best.id || "").trim();
  if (id)
    meta = mergeMetadata(
      meta,
      parseDoubanSubjectHtml(
        await fetchText(
          `https://book.douban.com/subject/${id}/`,
          timeout,
          fetcher,
        ),
      ),
    );
  return meta;
}
export async function lookupAmazon(
  query: string,
  timeout = 8,
  fetcher: Fetch = fetch,
): Promise<LookupMetadata | null> {
  const html = await fetchText(
    `https://www.amazon.com/s?k=${quoteComponent(query).replaceAll("%2F", "/")}&i=stripbooks`,
    timeout,
    fetcher,
  );
  const asin =
    html.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ||
    html.match(/data-asin=["']([A-Z0-9]{10})["']/)?.[1];
  return asin
    ? parseAmazonProductHtml(
        await fetchText(`https://www.amazon.com/dp/${asin}`, timeout, fetcher),
      )
    : null;
}
export async function lookupBookMetadataCandidates(
  query: string,
  options: { timeout?: number; author?: string | null; fetch?: Fetch } = {},
) {
  query = (query || "").trim();
  const candidates: Record<string, LookupMetadata> = {},
    errors: string[] = [],
    attempts: LookupAttempt[] = [];
  if (!query)
    return {
      candidates,
      best_source: null,
      errors: ["空标题无法检索"],
      attempts,
    };
  try {
    const item = await lookupDouban(
      query,
      options.timeout ?? 8,
      options.author,
      options.fetch,
    );
    if (!item)
      attempts.push({
        source: "douban",
        ok: false,
        title: null,
        score: 0,
        error: "未命中",
        selected: false,
      });
    else {
      candidates.douban = item;
      attempts.push({
        source: "douban",
        ok: true,
        title: item.title,
        score: metadataScore(item, query, options.author),
        error: null,
        selected: true,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`douban: ${message}`);
    attempts.push({
      source: "douban",
      ok: false,
      title: null,
      score: 0,
      error: message,
      selected: false,
    });
  }
  return {
    candidates,
    best_source: candidates.douban ? "douban" : null,
    errors,
    attempts,
  };
}
export async function lookupBookMetadataVerbose(
  query: string,
  options: Parameters<typeof lookupBookMetadataCandidates>[1] = {},
) {
  const result = await lookupBookMetadataCandidates(query, options);
  return {
    best: result.best_source ? result.candidates[result.best_source] : null,
    errors: result.errors,
    attempts: result.attempts,
  };
}
export async function lookupBookMetadata(
  query: string,
  options: Parameters<typeof lookupBookMetadataCandidates>[1] = {},
) {
  const { best, errors } = await lookupBookMetadataVerbose(query, options);
  return { best, errors };
}
