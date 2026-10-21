import type { Book, Chapter, Volume } from "./models";
import { compilePattern, strip } from "./text";
import { decodeGb18030 } from "./gb18030";
export interface RuleConfig {
  rule_id: string;
  name: string;
  chapter_patterns: string[];
  volume_patterns: string[];
  special_headings: string[];
  heading_max_len: number;
  heading_max_commas: number;
  skip_candidate_re: string;
}
export interface RuleSet extends Omit<
  RuleConfig,
  "chapter_patterns" | "volume_patterns" | "skip_candidate_re"
> {
  config: RuleConfig;
  chapter_patterns: RegExp[];
  volume_patterns: RegExp[];
  skip_candidate_re: RegExp;
}
export interface ParsedBookHeader {
  title: string;
  author: string | null;
  intro: string | null;
}
export interface ParsedBookSection {
  kind: string;
  title: string;
  lines: string[];
  volume_title: string | null;
}
export type ParsedBookEvent = ParsedBookHeader | ParsedBookSection;
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  rule_id: "default",
  name: "默认",
  chapter_patterns: [
    "^第\\s*[0-9一二三四五六七八九十百千万两零〇]+\\s*章.*$",
    "^第\\s*[0-9一二三四五六七八九十百千万两零〇]+\\s*节.*$",
    "^第\\s*[0-9一二三四五六七八九十百千万两零〇]+\\s*回.*$",
    "(?i)^Chapter\\s+\\d+.*$",
  ],
  volume_patterns: [
    "^第\\s*[0-9一二三四五六七八九十百千万两零〇]+\\s*卷.*$",
    "^卷\\s*[0-9一二三四五六七八九十百千万两零〇]+.*$",
    "^第\\s*[0-9一二三四五六七八九十百千万两零〇]+\\s*部.*$",
  ],
  special_headings: [
    "序章",
    "序",
    "楔子",
    "引子",
    "前言",
    "前序",
    "后记",
    "后序",
    "尾声",
    "结语",
    "终章",
    "终卷",
    "终篇",
    "番外",
    "番外篇",
    "作者的话",
    "完结感言",
  ],
  heading_max_len: 40,
  heading_max_commas: 1,
  skip_candidate_re:
    "(http|www|QQ群|群|公众号|微信|下载|txt|整理|校对|打包|本书|电子书)",
};
export function buildRules(config: RuleConfig): RuleSet {
  return {
    ...config,
    config,
    chapter_patterns: config.chapter_patterns.map(compilePattern),
    volume_patterns: config.volume_patterns.map(compilePattern),
    special_headings: [...config.special_headings],
    skip_candidate_re: compilePattern(config.skip_candidate_re),
  };
}
export const DEFAULT_RULES = buildRules(DEFAULT_RULE_CONFIG);
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  try {
    return decodeGb18030(data);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(data);
}
export function isLikelyHeadingLine(
  line: string,
  prev: string | null,
  next: string | null,
  rules: RuleSet,
): boolean {
  const s = strip(line);
  if (!s) return false;
  const isolated =
    prev === null || !strip(prev) || next === null || !strip(next);
  if (
    !isolated &&
    (/[。！？]$/.test(s) ||
      [...s].length > rules.heading_max_len ||
      (s.match(/[，,]/g)?.length ?? 0) > rules.heading_max_commas)
  )
    return false;
  return true;
}
export function classifyHeading(
  line: string,
  prev: string | null = null,
  next: string | null = null,
  rules = DEFAULT_RULES,
): "chapter" | "volume" | null {
  const s = strip(line);
  if (!s) return null;
  const matches = (pattern: RegExp) => pattern.exec(s)?.index === 0;
  const plausible = () => isLikelyHeadingLine(line, prev, next, rules);
  if (rules.chapter_patterns.some(matches))
    return plausible() ? "chapter" : null;
  if (
    rules.special_headings.some(
      (k) => s === k || [" ", "：", ":"].some((sep) => s.startsWith(k + sep)),
    )
  )
    return plausible() ? "chapter" : null;
  if (rules.volume_patterns.some(matches)) return plausible() ? "volume" : null;
  return null;
}
export function isHeading(
  line: string,
  prev: string | null = null,
  next: string | null = null,
  rules = DEFAULT_RULES,
): boolean {
  return classifyHeading(line, prev, next, rules) !== null;
}
const labelRe = compilePattern(
  "^(书名|作者|作\\s*者|内容简介|简介|内容介绍|文案)\\s*[:：]\\s*(.*)\\s*$",
);
export function parseMetadata(
  lines: string[],
  rules = DEFAULT_RULES,
): [string | null, string | null, string | null, Set<number>] {
  let title: string | null = null,
    author: string | null = null,
    pending: string | null = null,
    inIntro = false,
    nonEmpty = 0;
  const intro: string[] = [],
    skip = new Set<number>(),
    candidates: [number, string][] = [];
  const first = lines.findIndex((l, i) =>
    isHeading(l, lines[i - 1] ?? null, lines[i + 1] ?? null, rules),
  );
  for (let i = 0; i < (first < 0 ? lines.length : first); i++) {
    const s = strip(lines[i]);
    if (!s) {
      if (inIntro && intro.length) inIntro = false;
      continue;
    }
    if (inIntro) {
      intro.push(s);
      skip.add(i);
      continue;
    }
    const m = labelRe.exec(s);
    if (m) {
      const label = m[1],
        value = strip(m[2]);
      skip.add(i);
      if (label === "书名") {
        if (value) title = value;
        else pending = "title";
      } else if (["作者", "作 者"].includes(label)) {
        if (value) author = value;
        else pending = "author";
      } else {
        if (value) intro.push(value);
        inIntro = true;
      }
      continue;
    }
    if (["书名", "书 名"].includes(s)) {
      pending = "title";
      skip.add(i);
      continue;
    }
    if (["作者", "作 者"].includes(s)) {
      pending = "author";
      skip.add(i);
      continue;
    }
    if (["内容简介", "简介", "内容介绍", "文案"].includes(s)) {
      inIntro = true;
      skip.add(i);
      continue;
    }
    if (pending && /^[:：]/.test(s)) {
      const value = strip(s.slice(1));
      skip.add(i);
      if (pending === "title" && value) title = value;
      else if (pending === "author" && value) author = value;
      pending = null;
      continue;
    }
    const t = /^《(.+)》$/.exec(s);
    if (t && title === null) {
      title = strip(t[1]);
      skip.add(i);
      continue;
    }
    nonEmpty++;
    if (nonEmpty <= 6 && !rules.skip_candidate_re.test(s))
      candidates.push([i, s]);
  }
  if (title === null && candidates.length) {
    title = candidates[0][1];
    skip.add(candidates[0][0]);
  }
  if (author === null && candidates.length >= 2 && candidates[1][1] !== title) {
    author = candidates[1][1];
    skip.add(candidates[1][0]);
  }
  return [title, author, intro.length ? strip(intro.join("\n")) : null, skip];
}
export function normalizeContentLine(line: string): string {
  return strip(line).replace(/\u3000/g, "");
}
function* textLines(text: string): Generator<string> {
  // StringIO iterates on LF only; do not use JS/legacy splitlines here.
  let start = 0;
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") {
      yield text.slice(start, i).replace(/[\r\n]+$/, "");
      start = i + 1;
    }
  if (start < text.length) yield text.slice(start).replace(/[\r\n]+$/, "");
}
function prepare(
  lines: Iterator<string>,
  sourceName: string,
  rules: RuleSet,
): { header: ParsedBookHeader; body: Iterable<string> } {
  const prelude: string[] = [];
  let prev: string | null = null,
    current = lines.next(),
    next = lines.next();
  while (!current.done) {
    if (isHeading(current.value, prev, next.done ? null : next.value, rules))
      break;
    prelude.push(current.value);
    prev = current.value;
    current = next;
    next = lines.next();
  }
  const [title, author, intro, skip] = parseMetadata(prelude, rules);
  function* body() {
    for (let i = 0; i < prelude.length; i++) if (!skip.has(i)) yield prelude[i];
    if (!current.done) {
      yield current.value;
      if (!next.done) yield next.value;
      for (let n = lines.next(); !n.done; n = lines.next()) yield n.value;
    }
  }
  return {
    header: { title: title || sourceName, author, intro },
    body: body(),
  };
}
function* contextual(
  lines: Iterable<string>,
): Generator<[string, string | null, string | null]> {
  const it = lines[Symbol.iterator]();
  let prev: string | null = null,
    current = it.next(),
    next = it.next();
  while (!current.done) {
    yield [current.value, prev, next.done ? null : next.value];
    prev = current.value;
    current = next;
    next = it.next();
  }
}
export function parseBook(
  text: string,
  sourceName: string,
  rules = DEFAULT_RULES,
): Book {
  return parseBookFromLines(textLines(text), sourceName, rules);
}
export function parseBookFromLines(
  lines: Iterable<string>,
  sourceName: string,
  rules = DEFAULT_RULES,
): Book {
  const { header, body } = prepare(lines[Symbol.iterator](), sourceName, rules);
  const book: Book = { ...header, volumes: [], root_chapters: [], spine: [] };
  let volume: Volume | null = null,
    chapter: Chapter | null = null;
  function startChapter(title: string) {
    const c: Chapter = { title, lines: [], volume };
    (volume ? volume.chapters : book.root_chapters).push(c);
    book.spine.push(c);
    return c;
  }
  for (const [line, prev, next] of contextual(body)) {
    const kind = classifyHeading(line, prev, next, rules);
    if (kind === "volume") {
      chapter = null;
      volume = { title: strip(line), lines: [], chapters: [] };
      book.volumes.push(volume);
      book.spine.push(volume);
    } else if (kind === "chapter") chapter = startChapter(strip(line));
    else {
      const content = normalizeContentLine(line);
      if (!content) continue;
      if (chapter) chapter.lines.push(content);
      else if (volume) volume.lines.push(content);
      else {
        chapter = book.root_chapters.at(-1) ?? startChapter("正文");
        chapter.lines.push(content);
      }
    }
  }
  return book;
}
export function* parseBookEvents(
  text: string,
  sourceName: string,
  rules = DEFAULT_RULES,
): Generator<ParsedBookEvent> {
  yield* parseBookEventsFromLines(textLines(text), sourceName, rules);
}
export function* parseBookEventsFromLines(
  lines: Iterable<string>,
  sourceName: string,
  rules = DEFAULT_RULES,
): Generator<ParsedBookEvent> {
  const { header, body } = prepare(lines[Symbol.iterator](), sourceName, rules);
  yield header;
  let volumeTitle: string | null = null,
    volumeLines: string[] = [],
    chapter: ParsedBookSection | null = null;
  for (const [line, prev, next] of contextual(body)) {
    const kind = classifyHeading(line, prev, next, rules);
    if (kind) {
      if (chapter) {
        yield chapter;
        chapter = null;
      }
      if (volumeTitle !== null && volumeLines.length) {
        yield {
          kind: "volume",
          title: volumeTitle,
          lines: volumeLines,
          volume_title: null,
        };
        volumeLines = [];
      }
      if (kind === "volume") {
        volumeTitle = strip(line);
        volumeLines = [];
      } else
        chapter = {
          kind: "chapter",
          title: strip(line),
          lines: [],
          volume_title: volumeTitle,
        };
    } else {
      const content = normalizeContentLine(line);
      if (!content) continue;
      if (chapter) chapter.lines.push(content);
      else if (volumeTitle !== null) volumeLines.push(content);
      else
        chapter = {
          kind: "chapter",
          title: "正文",
          lines: [content],
          volume_title: null,
        };
    }
  }
  if (chapter) yield chapter;
  if (volumeTitle !== null && volumeLines.length)
    yield {
      kind: "volume",
      title: volumeTitle,
      lines: volumeLines,
      volume_title: null,
    };
}
// File I/O belongs to server; these byte APIs also work with browser File.arrayBuffer().
export function parseBookBytes(
  data: Uint8Array,
  sourceName: string,
  rules = DEFAULT_RULES,
): Book {
  return parseBook(decodeText(data).replace(/\r\n?/g, "\n"), sourceName, rules);
}
export function parseBookByteEvents(
  data: Uint8Array,
  sourceName: string,
  rules = DEFAULT_RULES,
): Generator<ParsedBookEvent> {
  return parseBookEvents(
    decodeText(data).replace(/\r\n?/g, "\n"),
    sourceName,
    rules,
  );
}
export function textHasContent(data: Uint8Array): boolean {
  return Boolean(strip(decodeText(data)));
}
