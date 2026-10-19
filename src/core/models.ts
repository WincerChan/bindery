export interface Chapter {
  title: string;
  lines: string[];
  volume: Volume | null;
}
export interface Volume {
  title: string;
  lines: string[];
  chapters: Chapter[];
}
export interface Book {
  title: string;
  author: string | null;
  intro: string | null;
  volumes: Volume[];
  root_chapters: Chapter[];
  spine: (Volume | Chapter)[];
}
export interface Metadata {
  book_id: string;
  title: string;
  author: string | null;
  language: string;
  description: string | null;
  source_type: string;
  series: string | null;
  identifier: string | null;
  publisher: string | null;
  tags: string[];
  published: string | null;
  isbn: string | null;
  rating: number | null;
  status: string;
  epub_updated_at: string | null;
  archived: boolean;
  read: boolean;
  read_updated_at: string | null;
  cover_file: string | null;
  rule_template: string | null;
  theme_template: string | null;
  custom_css: string | null;
  created_at: string;
  updated_at: string;
}
export interface Job {
  id: string;
  book_id: string | null;
  action: string;
  status: string;
  stage: string | null;
  message: string | null;
  log: string | null;
  rule_template: string | null;
  created_at: string;
  updated_at: string;
}
export interface Wish {
  id: string;
  title: string;
  library_book_id: string | null;
  author: string | null;
  rating: number | null;
  read: boolean;
  read_status: string;
  tags: string[];
  comment: string | null;
  book_status: string;
  created_at: string;
  updated_at: string;
}
export interface ChapterData {
  title: string;
  lines: string[];
}
export interface VolumeData extends ChapterData {
  chapters: ChapterData[];
}
export type SpineEntry =
  | { type: "volume"; index: number }
  | { type: "chapter"; scope: "root"; index: number }
  | {
      type: "chapter";
      scope: "volume";
      volume_index: number;
      chapter_index: number;
    };
export interface BookData {
  title: string;
  author: string | null;
  intro: string | null;
  volumes: VolumeData[];
  root_chapters: ChapterData[];
  spine: SpineEntry[];
}
export function chapterToDict(chapter: Chapter): ChapterData {
  return { title: chapter.title, lines: [...chapter.lines] };
}
export function chapterFromDict(
  data: Partial<ChapterData>,
  volume: Volume | null = null,
): Chapter {
  return { title: data.title ?? "", lines: [...(data.lines ?? [])], volume };
}
export function volumeToDict(volume: Volume): VolumeData {
  return {
    title: volume.title,
    lines: [...volume.lines],
    chapters: volume.chapters.map(chapterToDict),
  };
}
export function volumeFromDict(data: Partial<VolumeData>): Volume {
  const volume: Volume = {
    title: data.title ?? "",
    lines: [...(data.lines ?? [])],
    chapters: [],
  };
  volume.chapters = (data.chapters ?? []).map((c) =>
    chapterFromDict(c, volume),
  );
  return volume;
}
export function bookToDict(book: Book): BookData {
  const spine: SpineEntry[] = book.spine.map((item) => {
    if ("chapters" in item)
      return { type: "volume", index: Math.max(0, book.volumes.indexOf(item)) };
    if (item.volume)
      return {
        type: "chapter",
        scope: "volume",
        volume_index: Math.max(0, book.volumes.indexOf(item.volume)),
        chapter_index: Math.max(0, item.volume.chapters.indexOf(item)),
      };
    return {
      type: "chapter",
      scope: "root",
      index: Math.max(0, book.root_chapters.indexOf(item)),
    };
  });
  return {
    title: book.title,
    author: book.author,
    intro: book.intro,
    volumes: book.volumes.map(volumeToDict),
    root_chapters: book.root_chapters.map(chapterToDict),
    spine,
  };
}
export function bookFromDict(data: Partial<BookData>): Book {
  const book: Book = {
    title: data.title ?? "",
    author: data.author ?? null,
    intro: data.intro ?? null,
    volumes: (data.volumes ?? []).map(volumeFromDict),
    root_chapters: (data.root_chapters ?? []).map((c) => chapterFromDict(c)),
    spine: [],
  };
  for (const entry of data.spine ?? []) {
    const item =
      entry.type === "volume"
        ? book.volumes[entry.index ?? 0]
        : entry.scope === "volume"
          ? book.volumes[entry.volume_index ?? 0]?.chapters[
              entry.chapter_index ?? 0
            ]
          : book.root_chapters[entry.index ?? 0];
    if (item) book.spine.push(item);
  }
  if (!book.spine.length)
    book.spine = [
      ...book.volumes.flatMap((v) => [v, ...v.chapters]),
      ...book.root_chapters,
    ];
  return book;
}
export function metadataFromDict(data: Partial<Metadata>): Metadata {
  return {
    book_id: "",
    title: "",
    author: null,
    language: "zh-CN",
    description: null,
    source_type: "txt",
    series: null,
    identifier: null,
    publisher: null,
    tags: [],
    published: null,
    isbn: null,
    rating: null,
    status: "synced",
    epub_updated_at: null,
    archived: false,
    read: false,
    read_updated_at: null,
    cover_file: null,
    rule_template: null,
    theme_template: null,
    custom_css: null,
    created_at: "",
    updated_at: "",
    ...data,
    ...("tags" in data ? { tags: [...data.tags!] } : {}),
  };
}
export function metadataToDict(meta: Metadata): Metadata {
  return { ...meta, tags: [...meta.tags] };
}
