from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html import unescape
from typing import Any, Optional

from lxml import etree, html as lxml_html

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)
DESCRIPTION_XPATH = "//div[@id='link-report']//div[@class='intro']"


@dataclass
class LookupMetadata:
    source: str
    title: Optional[str] = None
    author: Optional[str] = None
    language: Optional[str] = None
    description: Optional[str] = None
    publisher: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    published: Optional[str] = None
    isbn: Optional[str] = None
    cover_url: Optional[str] = None


def _clean_text(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    value = unescape(value)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def _clean_date(value: Optional[str]) -> Optional[str]:
    cleaned = _clean_text(value)
    if not cleaned:
        return None
    match = re.search(r"\d{4}(?:-\d{1,2}(?:-\d{1,2})?)?", cleaned)
    return match.group(0) if match else cleaned


def _clean_isbn(value: Optional[str]) -> Optional[str]:
    cleaned = _clean_text(value)
    if not cleaned:
        return None
    match = re.search(r"[0-9Xx-]{10,20}", cleaned)
    return match.group(0).upper() if match else cleaned


def _clean_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    url = unescape(str(value)).strip()
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    if not re.match(r"^https?://", url, flags=re.IGNORECASE):
        return None
    return url


def _split_tags(raw: Optional[str]) -> list[str]:
    cleaned = _clean_text(raw)
    if not cleaned:
        return []
    parts = re.split(r"[，,;/|]", cleaned)
    seen: set[str] = set()
    tags: list[str] = []
    for item in parts:
        value = item.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        tags.append(value)
    return tags


def _extract_douban_tag_links(html: str) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(
        r"<a[^>]*class=[\"'][^\"']*\btag\b[^\"']*[\"'][^>]*>(.*?)</a>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        value = _clean_text(match.group(1))
        if not value or value in seen:
            continue
        seen.add(value)
        tags.append(value)
    return tags


def _extract_douban_criteria_tags(html: str) -> list[str]:
    match = re.search(
        r"criteria\s*=\s*([\"'])(.*?)\1",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return []
    criteria = unescape(match.group(2))
    tags: list[str] = []
    seen: set[str] = set()
    for item in criteria.split("|"):
        item = item.strip()
        if not item.startswith("7:"):
            continue
        value = _clean_text(item[2:].strip())
        if not value or value in seen:
            continue
        seen.add(value)
        tags.append(value)
    return tags


def _extract_douban_cover_href(html: str) -> Optional[str]:
    for match in re.finditer(r"<a\b([^>]*)>", html, flags=re.IGNORECASE | re.DOTALL):
        attrs = match.group(1)
        class_match = re.search(r"class=[\"']([^\"']*)[\"']", attrs, flags=re.IGNORECASE | re.DOTALL)
        if not class_match:
            continue
        class_value = _clean_text(class_match.group(1)) or ""
        if not re.search(r"(^|\s)nbg(\s|$)", class_value, flags=re.IGNORECASE):
            continue
        href_match = re.search(r"href=[\"'](.*?)[\"']", attrs, flags=re.IGNORECASE | re.DOTALL)
        if not href_match:
            continue
        href = _clean_url(href_match.group(1))
        if href:
            return href
    return None


def _pick_author(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return _clean_text(value)
    if isinstance(value, dict):
        return _clean_text(value.get("name"))
    if isinstance(value, list):
        names = [_pick_author(item) for item in value]
        names = [name for name in names if name]
        if not names:
            return None
        return ", ".join(names)
    return None


def _pick_description(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return _clean_text(value)
    if isinstance(value, dict):
        for key in ("@value", "value", "text"):
            text = _clean_text(value.get(key))
            if text:
                return text
        return None
    if isinstance(value, list):
        parts = [_pick_description(item) for item in value]
        parts = [part for part in parts if part]
        if not parts:
            return None
        return "\n".join(parts)
    return None


def _pick_image_url(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return _clean_url(value)
    if isinstance(value, dict):
        for key in ("url", "contentUrl", "@id"):
            found = _clean_url(value.get(key))
            if found:
                return found
        return None
    if isinstance(value, list):
        for item in value:
            found = _pick_image_url(item)
            if found:
                return found
        return None
    return None


def _extract_amazon_rpi_value(html: str, key: str) -> Optional[str]:
    pattern = (
        r'<div[^>]+id=["\']rpi-attribute-'
        + re.escape(key)
        + r'["\'][^>]*>.*?'
        + r'<div[^>]+rpi-attribute-value[^>]*>\s*<span>(.*?)</span>'
    )
    match = re.search(pattern, html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return _clean_text(match.group(1))


def _extract_amazon_product_title(html: str) -> Optional[str]:
    match = re.search(
        r'<span[^>]+id=["\']productTitle["\'][^>]*>(.*?)</span>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match:
        return _clean_text(match.group(1))

    meta_match = re.search(
        r'<meta[^>]+name=["\']title["\'][^>]+content=["\'](.*?)["\'][^>]*>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not meta_match:
        return None
    raw = _clean_text(meta_match.group(1)) or ""
    # e.g. "Amazon.com: Pirates Past Noon ...: 8601...: Author: 图书"
    title_match = re.search(r"Amazon\.com[:：]\s*(.+?)(?:\s*:\s*[0-9Xx-]{10,20}\b|$)", raw, flags=re.IGNORECASE)
    if title_match:
        return _clean_text(title_match.group(1))
    return raw or None


def _extract_amazon_byline_authors(html: str) -> Optional[str]:
    block_match = re.search(
        r'<div[^>]+id=["\']bylineInfo["\'][^>]*>(.*?)</div>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not block_match:
        return None
    block = block_match.group(1)
    names: list[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"<a[^>]*>(.*?)</a>", block, flags=re.IGNORECASE | re.DOTALL):
        name = _clean_text(match.group(1))
        if not name or name in seen:
            continue
        seen.add(name)
        names.append(name)
    if not names:
        return None
    return ", ".join(names)


def _extract_amazon_description(html: str) -> Optional[str]:
    try:
        document = lxml_html.fromstring(html)
    except (etree.ParserError, ValueError):
        return None

    candidates: list[str] = []
    seen: set[str] = set()

    for xpath in (
        "//*[@id='bookDescription_feature_div']//span[contains(@class,'a-expander-partial-collapse-content')]",
        "//*[@id='bookDescription_feature_div']//div[contains(@class,'a-expander-content')]",
        "//*[@id='bookDescription_feature_div']",
    ):
        nodes = document.xpath(xpath)
        for node in nodes:
            if not isinstance(node, etree._Element):
                continue
            text = _clean_text(node.text_content())
            if not text or len(text) < 40:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            candidates.append(text)

    if candidates:
        return max(candidates, key=len)

    bullets: list[str] = []
    bullet_seen: set[str] = set()
    for node in document.xpath("//*[@id='feature-bullets']//span[contains(@class,'a-list-item')]"):
        if not isinstance(node, etree._Element):
            continue
        text = _clean_text(node.text_content())
        if not text or len(text) < 12:
            continue
        key = text.lower()
        if key in bullet_seen:
            continue
        bullet_seen.add(key)
        bullets.append(text)

    if bullets:
        return "\n".join(f"- {item}" for item in bullets[:6])
    return None


def _html_fragment_to_markdownish(raw_html: str) -> Optional[str]:
    if not raw_html:
        return None
    text = raw_html
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*li[^>]*>", "- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(p|div|li|h[1-6]|tr)\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = text.replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip() or None


def _extract_douban_intro_description(html: str) -> Optional[str]:
    try:
        document = lxml_html.fromstring(html)
    except (etree.ParserError, ValueError):
        return None
    description_nodes = document.xpath(DESCRIPTION_XPATH)
    if not description_nodes:
        return None
    node = description_nodes[-1]
    if not isinstance(node, etree._Element):
        return None
    raw = etree.tostring(node, encoding="unicode", method="html")
    return _html_fragment_to_markdownish(raw)


def _iter_ld_json_objects(html: str) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for match in re.finditer(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            data = json.loads(unescape(raw))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            objects.append(data)
        elif isinstance(data, list):
            objects.extend(item for item in data if isinstance(item, dict))
    return objects


def parse_douban_subject_html(html: str) -> LookupMetadata:
    metadata = LookupMetadata(source="douban")
    keywords_tags: list[str] = []
    for obj in _iter_ld_json_objects(html):
        obj_type = obj.get("@type")
        type_names = obj_type if isinstance(obj_type, list) else [obj_type]
        if "Book" not in type_names:
            continue
        metadata.title = _clean_text(obj.get("name")) or metadata.title
        metadata.author = _pick_author(obj.get("author")) or metadata.author
        metadata.description = _pick_description(obj.get("description")) or metadata.description
        publisher = obj.get("publisher")
        if isinstance(publisher, dict):
            metadata.publisher = _clean_text(publisher.get("name")) or metadata.publisher
        metadata.published = _clean_date(obj.get("datePublished")) or metadata.published
        metadata.isbn = _clean_isbn(obj.get("isbn")) or metadata.isbn
        metadata.language = _clean_text(obj.get("inLanguage")) or metadata.language
        metadata.cover_url = _pick_image_url(obj.get("image")) or metadata.cover_url
        keywords = obj.get("keywords")
        tags = _split_tags(keywords if isinstance(keywords, str) else None)
        if tags:
            keywords_tags = tags
        break

    intro_description = _extract_douban_intro_description(html)
    if intro_description:
        metadata.description = intro_description

    cover_from_nbg = _extract_douban_cover_href(html)
    if cover_from_nbg:
        metadata.cover_url = cover_from_nbg
    else:
        og_image_match = re.search(
            r"<meta[^>]+property=[\"']og:image[\"'][^>]+content=[\"'](.*?)[\"'][^>]*>",
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if og_image_match:
            metadata.cover_url = _clean_url(og_image_match.group(1)) or metadata.cover_url

    tag_links = _extract_douban_tag_links(html)
    if tag_links:
        metadata.tags = tag_links
    else:
        criteria_tags = _extract_douban_criteria_tags(html)
        if criteria_tags:
            metadata.tags = criteria_tags
        elif keywords_tags:
            metadata.tags = keywords_tags

    if not metadata.description:
        meta_match = re.search(
            r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'](.*?)[\"'][^>]*>",
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if meta_match:
            metadata.description = _clean_text(meta_match.group(1))

    page_text = _clean_text(html) or ""
    if not metadata.publisher:
        publisher_match = re.search(
            r"出版社[:：]\s*(.+?)(?=\s+(?:作者|原作名|副标题|译者|出版年|页数|定价|装帧|丛书|ISBN|统一书号|出品方|品牌方)[:：]|$)",
            page_text,
        )
        if publisher_match:
            metadata.publisher = _clean_text(publisher_match.group(1))
    if not metadata.isbn:
        isbn_match = re.search(r"ISBN[:：]\s*([0-9Xx-]{10,20})", page_text)
        if isbn_match:
            metadata.isbn = _clean_isbn(isbn_match.group(1))
    if not metadata.published:
        published_match = re.search(r"出版年[:：]\s*([0-9-]{4,10})", page_text)
        if published_match:
            metadata.published = _clean_date(published_match.group(1))

    return metadata


def parse_amazon_product_html(html: str) -> LookupMetadata:
    metadata = LookupMetadata(source="amazon")
    for obj in _iter_ld_json_objects(html):
        obj_type = obj.get("@type")
        type_names = obj_type if isinstance(obj_type, list) else [obj_type]
        if "Book" not in type_names and "Product" not in type_names:
            continue
        metadata.title = _clean_text(obj.get("name")) or metadata.title
        metadata.author = _pick_author(obj.get("author")) or metadata.author
        metadata.description = _pick_description(obj.get("description")) or metadata.description
        brand = obj.get("brand")
        if isinstance(brand, dict):
            metadata.publisher = _clean_text(brand.get("name")) or metadata.publisher
        metadata.published = _clean_date(obj.get("datePublished")) or metadata.published
        metadata.isbn = _clean_isbn(obj.get("isbn")) or metadata.isbn
        metadata.language = _clean_text(obj.get("inLanguage")) or metadata.language
        keywords = obj.get("keywords")
        tags = _split_tags(keywords if isinstance(keywords, str) else None)
        if tags:
            metadata.tags = tags
        if metadata.title:
            break

    if not metadata.title:
        metadata.title = _extract_amazon_product_title(html) or metadata.title
    if not metadata.author:
        metadata.author = _extract_amazon_byline_authors(html) or metadata.author
    if not metadata.description:
        metadata.description = _extract_amazon_description(html) or metadata.description
    if not metadata.publisher:
        metadata.publisher = _extract_amazon_rpi_value(html, "book_details-publisher") or metadata.publisher
    if not metadata.published:
        metadata.published = _clean_date(_extract_amazon_rpi_value(html, "book_details-publication_date")) or metadata.published
    if not metadata.language:
        metadata.language = _clean_text(_extract_amazon_rpi_value(html, "book_details-language")) or metadata.language
    if not metadata.isbn:
        isbn13 = _clean_isbn(_extract_amazon_rpi_value(html, "book_details-isbn13"))
        isbn10 = _clean_isbn(_extract_amazon_rpi_value(html, "book_details-isbn10"))
        metadata.isbn = isbn13 or isbn10 or metadata.isbn

    page_text = _clean_text(html) or ""
    if not metadata.publisher:
        publisher_match = re.search(r"Publisher[:：]\s*([^\n\r]+?)\s{2,}", page_text)
        if publisher_match:
            metadata.publisher = _clean_text(publisher_match.group(1))
    if not metadata.isbn:
        isbn_match = re.search(r"ISBN-1[03][:：]\s*([0-9Xx-]{10,20})", page_text)
        if isbn_match:
            metadata.isbn = _clean_isbn(isbn_match.group(1))
    if not metadata.published:
        date_match = re.search(r"Publication date[:：]\s*([0-9A-Za-z,\- ]+)", page_text)
        if date_match:
            metadata.published = _clean_date(date_match.group(1))
    if not metadata.language:
        language_match = re.search(r"Language[:：]\s*([A-Za-z\- ]+)", page_text)
        if language_match:
            metadata.language = _clean_text(language_match.group(1))
    if not metadata.description:
        meta_match = re.search(
            r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"'](.*?)[\"'][^>]*>",
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if meta_match:
            desc = _clean_text(meta_match.group(1))
            if desc and not desc.lower().startswith("amazon.com:"):
                metadata.description = desc

    return metadata


def _fetch_text(url: str, timeout: float = 8.0) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
    return data.decode(charset, errors="replace")


def _fetch_json(url: str, timeout: float = 8.0) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        data = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
    return json.loads(data.decode(charset, errors="replace"))


def _normalize_title(value: Optional[str]) -> str:
    cleaned = _clean_text(value) or ""
    return re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "", cleaned).lower()


def _title_match_score(result_title: Optional[str], query: str) -> int:
    target = _normalize_title(query)
    if not target:
        return 0
    title = _normalize_title(result_title)
    if not title:
        return 0
    if title == target:
        return 4
    if target in title or title in target:
        return 3
    common = sum(1 for ch in set(target) if ch in set(title))
    return 2 if common >= max(2, min(len(target), len(title)) // 2) else 0


def _metadata_score(item: LookupMetadata, query: str) -> int:
    score = _title_match_score(item.title, query) * 3
    if item.author:
        score += 2
    if item.description:
        score += 2
    if item.publisher:
        score += 1
    if item.isbn:
        score += 2
    if item.published:
        score += 1
    if item.tags:
        score += 1
    return score


def _lookup_douban(query: str, timeout: float) -> Optional[LookupMetadata]:
    suggest_url = "https://book.douban.com/j/subject_suggest?q=" + urllib.parse.quote(query)
    data = _fetch_json(suggest_url, timeout=timeout)
    if not isinstance(data, list) or not data:
        return None

    best_item: Optional[dict[str, Any]] = None
    best_score = -1
    for item in data:
        if not isinstance(item, dict):
            continue
        score = _title_match_score(str(item.get("title") or ""), query)
        if score > best_score:
            best_score = score
            best_item = item
    if not best_item:
        return None

    metadata = LookupMetadata(
        source="douban",
        title=_clean_text(str(best_item.get("title") or "")),
        author=_clean_text(str(best_item.get("author_name") or "")),
        published=_clean_date(str(best_item.get("year") or "")),
        cover_url=_clean_url(str(best_item.get("img") or best_item.get("cover") or "")),
    )

    subject_id = str(best_item.get("id") or "").strip()
    if subject_id:
        detail_url = f"https://book.douban.com/subject/{subject_id}/"
        detail_html = _fetch_text(detail_url, timeout=timeout)
        detail_meta = parse_douban_subject_html(detail_html)
        metadata = _merge_metadata(metadata, detail_meta)
    return metadata


def _lookup_amazon(query: str, timeout: float) -> Optional[LookupMetadata]:
    search_url = "https://www.amazon.com/s?k=" + urllib.parse.quote(query) + "&i=stripbooks"
    search_html = _fetch_text(search_url, timeout=timeout)

    asin_match = re.search(r"/dp/([A-Z0-9]{10})", search_html)
    if not asin_match:
        asin_match = re.search(r"data-asin=[\"']([A-Z0-9]{10})[\"']", search_html)
    if not asin_match:
        return None

    asin = asin_match.group(1)
    detail_url = f"https://www.amazon.com/dp/{asin}"
    detail_html = _fetch_text(detail_url, timeout=timeout)
    return parse_amazon_product_html(detail_html)


def _merge_metadata(primary: LookupMetadata, overlay: LookupMetadata) -> LookupMetadata:
    return LookupMetadata(
        source=primary.source or overlay.source,
        title=overlay.title or primary.title,
        author=overlay.author or primary.author,
        language=overlay.language or primary.language,
        description=overlay.description or primary.description,
        publisher=overlay.publisher or primary.publisher,
        tags=overlay.tags or primary.tags,
        published=overlay.published or primary.published,
        isbn=overlay.isbn or primary.isbn,
        cover_url=overlay.cover_url or primary.cover_url,
    )


def lookup_book_metadata_candidates(
    query: str, timeout: float = 8.0
) -> tuple[dict[str, LookupMetadata], Optional[str], list[str], list[dict[str, Any]]]:
    query = (query or "").strip()
    if not query:
        return {}, None, ["空标题无法检索"], []

    candidates: list[tuple[LookupMetadata, int]] = []
    candidate_by_source: dict[str, LookupMetadata] = {}
    errors: list[str] = []
    attempts: list[dict[str, Any]] = []

    for source_name, func in (("douban", _lookup_douban), ("amazon", _lookup_amazon)):
        try:
            item = func(query, timeout)
        except Exception as exc:
            errors.append(f"{source_name}: {exc}")
            attempts.append(
                {
                    "source": source_name,
                    "ok": False,
                    "title": None,
                    "score": 0,
                    "error": str(exc),
                    "selected": False,
                }
            )
            continue
        if not item:
            attempts.append(
                {
                    "source": source_name,
                    "ok": False,
                    "title": None,
                    "score": 0,
                    "error": "未命中",
                    "selected": False,
                }
            )
            continue
        score = _metadata_score(item, query)
        attempts.append(
            {
                "source": source_name,
                "ok": True,
                "title": item.title,
                "score": score,
                "error": None,
                "selected": False,
            }
        )
        candidates.append((item, score))
        candidate_by_source[source_name] = item

    if not candidates:
        return {}, None, errors, attempts

    candidates.sort(key=lambda pair: pair[1], reverse=True)
    best = candidates[0][0]
    for attempt in attempts:
        attempt["selected"] = bool(attempt["ok"] and attempt["source"] == best.source)
    return candidate_by_source, best.source, errors, attempts


def lookup_book_metadata_verbose(
    query: str, timeout: float = 8.0
) -> tuple[Optional[LookupMetadata], list[str], list[dict[str, Any]]]:
    candidates, best_source, errors, attempts = lookup_book_metadata_candidates(query, timeout=timeout)
    best = candidates.get(best_source) if best_source else None
    return best, errors, attempts


def lookup_book_metadata(query: str, timeout: float = 8.0) -> tuple[Optional[LookupMetadata], list[str]]:
    best, errors, _attempts = lookup_book_metadata_verbose(query, timeout=timeout)
    return best, errors
