// Port of bindery/epub_templates/*.j2. Jinja select_autoescape sees .j2 and leaves values raw.
export interface TemplateSection {
  item_id: string;
  href: string;
  title: string;
}
interface Context {
  identifier_urn?: string | number | null;
  identifier?: string | number | null;
  isbn?: string | number | null;
  title?: string | number | null;
  language?: string | number | null;
  author?: string | number | null;
  description?: string | number | null;
  publisher?: string | number | null;
  published?: string | number | null;
  series?: string | number | null;
  tags?: string[];
  rating?: string | number | null;
  modified?: string | number | null;
  sections?: TemplateSection[];
  cover_href?: string | number | null;
  cover_media_type?: string | number | null;
  cover_item_id?: string | number | null;
  lang?: string | number | null;
  stamp?: string | number | null;
  main_title?: string | number | null;
  kind?: string | number | null;
  paragraphs?: string[];
}
export function container(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n',
  );
  out.push("  <rootfiles>\n");
  out.push(
    '    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml" />\n',
  );
  out.push("  </rootfiles>\n");
  out.push("</container>");
  return out.join("");
}
export function content(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  out.push("<package\n");
  out.push('  xmlns="http://www.idpf.org/2007/opf"\n');
  out.push('  xmlns:dc="http://purl.org/dc/elements/1.1/"\n');
  out.push('  version="3.0"\n');
  out.push('  unique-identifier="BookId"\n');
  out.push(">\n");
  out.push("  <metadata>\n");
  out.push(
    '    <dc:identifier id="BookId">' +
      String(identifier_urn) +
      "</dc:identifier>\n",
  );
  if (identifier) {
    out.push(
      '    <dc:identifier id="identifier">' +
        String(identifier) +
        "</dc:identifier>\n",
    );
  }
  if (isbn) {
    out.push(
      '    <dc:identifier id="isbn">' + String(isbn) + "</dc:identifier>\n",
    );
  }
  out.push("    <dc:title>" + String(title) + "</dc:title>\n");
  out.push("    <dc:language>" + String(language) + "</dc:language>\n");
  if (author) {
    out.push("    <dc:creator>" + String(author) + "</dc:creator>\n");
  }
  if (description) {
    out.push(
      "    <dc:description>" + String(description) + "</dc:description>\n",
    );
  }
  if (publisher) {
    out.push("    <dc:publisher>" + String(publisher) + "</dc:publisher>\n");
  }
  if (published) {
    out.push("    <dc:date>" + String(published) + "</dc:date>\n");
  }
  for (const [index, tag] of (tags ?? []).entries()) {
    out.push("    <dc:subject>" + String(tag) + "</dc:subject>\n");
  }
  if (series) {
    out.push(
      '    <meta property="belongs-to-collection">' +
        String(series) +
        "</meta>\n",
    );
  }
  if (rating != null) {
    out.push('    <meta name="rating">' + String(rating) + "</meta>\n");
  }
  out.push(
    '    <meta property="dcterms:modified">' + String(modified) + "</meta>\n",
  );
  if (cover_item_id) {
    out.push(
      '    <meta name="cover" content="' + String(cover_item_id) + '" />\n',
    );
  }
  out.push("  </metadata>\n");
  out.push("  <manifest>\n");
  out.push(
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />\n',
  );
  out.push(
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />\n',
  );
  out.push(
    '    <item id="style" href="Styles/style.css" media-type="text/css" />\n',
  );
  if (cover_href && cover_media_type && cover_item_id) {
    out.push(
      '    <item id="' +
        String(cover_item_id) +
        '" href="' +
        String(cover_href) +
        '" media-type="' +
        String(cover_media_type) +
        '" properties="cover-image" />\n',
    );
  }
  for (const [index, section] of (sections ?? []).entries()) {
    out.push(
      '    <item id="' +
        String(section.item_id) +
        '" href="' +
        String(section.href) +
        '" media-type="application/xhtml+xml" />\n',
    );
  }
  out.push("  </manifest>\n");
  out.push('  <spine toc="ncx">\n');
  for (const [index, section] of (sections ?? []).entries()) {
    out.push('    <itemref idref="' + String(section.item_id) + '" />\n');
  }
  out.push("  </spine>\n");
  out.push("</package>");
  return out.join("");
}
export function intro(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  out.push(
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="' +
      String(lang) +
      '">\n',
  );
  out.push("  <head>\n");
  out.push('    <meta charset="utf-8" />\n');
  out.push("    <title>" + String(title) + "</title>\n");
  out.push(
    '    <link rel="stylesheet" type="text/css" href="../Styles/style.css" />\n',
  );
  out.push("  </head>\n");
  out.push('  <body class="front-matter">\n');
  out.push("    <h1>" + String(title) + "</h1>\n");
  if (author) {
    out.push('    <p class="author">作者：' + String(author) + "</p>\n");
  }
  out.push('    <p class="intro-label">简介</p>\n');
  for (const [index, paragraph] of (paragraphs ?? []).entries()) {
    out.push("    <p>" + String(paragraph) + "</p>\n");
  }
  out.push("  </body>\n");
  out.push("</html>");
  return out.join("");
}
export function nav(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  out.push(
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="' +
      String(lang) +
      '">\n',
  );
  out.push("  <head>\n");
  out.push('    <meta charset="utf-8" />\n');
  out.push("    <title>" + String(title) + "</title>\n");
  out.push("  </head>\n");
  out.push("  <body>\n");
  out.push(
    '    <nav epub:type="toc" id="toc" xmlns:epub="http://www.idpf.org/2007/ops">\n',
  );
  out.push("      <h1>目录</h1>\n");
  out.push("      <ol>\n");
  for (const [index, section] of (sections ?? []).entries()) {
    out.push(
      '        <li><a href="' +
        String(section.href) +
        '">' +
        String(section.title) +
        "</a></li>\n",
    );
  }
  out.push("      </ol>\n");
  out.push("    </nav>\n");
  out.push("  </body>\n");
  out.push("</html>");
  return out.join("");
}
export function section(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  out.push(
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="' +
      String(lang) +
      '">\n',
  );
  out.push("  <head>\n");
  out.push('    <meta charset="utf-8" />\n');
  out.push("    <title>" + String(title) + "</title>\n");
  out.push(
    '    <link rel="stylesheet" type="text/css" href="../Styles/style.css" />\n',
  );
  out.push("  </head>\n");
  out.push('  <body class="' + String(kind) + '">\n');
  out.push('    <header class="chapter-header">\n');
  if (stamp) {
    out.push('      <p class="chapter-stamp">' + String(stamp) + "</p>\n");
  }
  out.push('      <h1 class="chapter-title">' + String(main_title) + "</h1>\n");
  out.push("    </header>\n");
  for (const [index, paragraph] of (paragraphs ?? []).entries()) {
    out.push("    <p>" + String(paragraph) + "</p>\n");
  }
  out.push("  </body>\n");
  out.push("</html>");
  return out.join("");
}
export function toc(context: Context = {}): string {
  const {
    identifier_urn,
    identifier,
    isbn,
    title,
    language,
    author,
    description,
    publisher,
    published,
    series,
    tags,
    rating,
    modified,
    sections,
    cover_href,
    cover_media_type,
    cover_item_id,
    lang,
    stamp,
    main_title,
    kind,
    paragraphs,
  } = context;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>\n');
  out.push(
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n',
  );
  out.push("  <head>\n");
  out.push('    <meta name="dtb:uid" content="' + String(title) + '" />\n');
  out.push("  </head>\n");
  out.push("  <docTitle>\n");
  out.push("    <text>" + String(title) + "</text>\n");
  out.push("  </docTitle>\n");
  out.push("  <navMap>\n");
  for (const [index, section] of (sections ?? []).entries()) {
    out.push(
      '    <navPoint id="navPoint-' +
        String(index + 1) +
        '" playOrder="' +
        String(index + 1) +
        '">\n',
    );
    out.push("      <navLabel>\n");
    out.push("        <text>" + String(section.title) + "</text>\n");
    out.push("      </navLabel>\n");
    out.push('      <content src="' + String(section.href) + '" />\n');
    out.push("    </navPoint>\n");
  }
  out.push("  </navMap>\n");
  out.push("</ncx>");
  return out.join("");
}
