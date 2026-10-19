# Bindery Design Spec · Editorial Index

> Swiss-grid typography × instrument panel. Neutral gray background, ink-black text, one signal orange. Metadata in small monospace. Covers are the only imagery on the page, laid flat with no 3D effects. The goal is to see a lot and see it clearly, not decoration.

Prototype source: the `*.dc.html` files under `docs/design/prototype/` (in the Claude Design canvas format). The `<style>` blocks and markup can be read directly as visual reference; `{{…}}`, `<sc-for>` and `<sc-if>` are prototype template syntax and do not go into the product. `/_blob/...` is a sample cover image in the prototype.

| Board | What it shows |
| --- | --- |
| `Main.dc.html` | Desktop library · cover wall (incl. hover state, generated covers, status tags) |
| `List.dc.html` | Desktop library · list view + multi-select floating bar |
| `Book.dc.html` | Desktop book detail |
| `Login.dc.html` | Login |
| `Tokens.dc.html` | Color / type / components / generated covers |
| `MLibrary.dc.html` `MSelect.dc.html` `MBook.dc.html` `MMore.dc.html` | Phone (< 768px): library, multi-select, detail, "More" |

---

## 1. Tokens (Tailwind v4 `@theme`, in `static/tailwind.css`)

### Color

| token | value | use |
| --- | --- | --- |
| `--color-bg` | `#EFEFEC` | Page background |
| `--color-surface` | `#FAFAF8` | Input fields, secondary buttons, tab bar, selected/raised surfaces |
| `--color-line` | `#D6D6D1` | All 1px rules, borders |
| `--color-mute` | `#B5B5AF` | Disabled text, placeholder dashes "—" |
| `--color-ink` | `#141414` | Primary text, primary buttons, rule above tables |
| `--color-ink-2` | `#4A4A47` | Secondary text |
| `--color-ink-3` | `#75756F` | Supporting text, labels, mono metadata |
| `--color-ink-4` | `#3A3A38` | Dark-gray cover tone |
| `--color-accent` | `#FF5A1F` | Signal orange (usage limits below) |
| `--color-accent-50` | `#FFE6DB` | Background of selected rows |
| `--color-accent-soft` | `#FF9E7A` | Danger action text on dark backgrounds (e.g. "批量归档" in the bulk bar) |
| `--color-ok` | `#2E7D4F` | Success, "✓ 已读" |
| `--color-warn` | `#F2B233` | In progress (black text on it) |
| `--color-danger` | `#C2341B` | Danger text / failed tag (white text on it) |
| `--color-danger-line` | `#E9B9AE` | Danger button border |

**Orange is used only for**: the current-nav indicator line, selection state (checkbox, selected count), focus ring, unread dot, rating stars. Only black text sits on an orange background. **Primary buttons are always black.** Generated covers never use orange.

### Type (no web fonts)

- `--font-sans`: `"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif`
- `--font-mono`: `"SF Mono","JetBrains Mono","Cascadia Mono",ui-monospace,Menlo,monospace` — numbers, dates, format (TXT/EPUB), counts, ISBN, table headers
- Scale: page title 22/700 (`letter-spacing:-.01em`); detail book title 32/700 (21 on phone); section title 15/600; card book title 13.5/600; body 14/400; supporting 12–12.5; mono metadata 11–12; table header mono 11 uppercase `letter-spacing:.06em`
- Remove all `font-mono`-styled debug text (e.g. `/library`)

### Shape and depth

- Corner radius is uniformly **2px** (inputs, buttons, chips, tags, floating bars); covers have **square corners**
- Panels/forms/cards **have no shadows**; only a 1px `line` stroke or no stroke at all. The current `bg-white rounded-xl shadow-sm border` card-box style is removed entirely
- Only floating layers get shadows: the bulk-action bar, modals, toasts, the phone "入库" floating button
- Dividers come in only two kinds: `line` hairlines (header, list rows, sections) and `ink` rules (above table headers, above detail spec tables, at list starts). No double lines or other decorative lines
- Focus: `focus-visible` → `border-ink` + `box-shadow:0 0 0 3px rgb(255 90 31 / .28)`; all custom controls must keep a visible focus
- Motion 150–200ms; respect `prefers-reduced-motion`

---

## 2. Components (implement as `@layer components` classes in `tailwind.css`; don't copy long class strings into each template)

| class | spec |
| --- | --- |
| `.btn` | Height 34px (≥ 44px on phone), `px-3.5`, 13px, 2px corners, `inline-flex gap-1.5`, `whitespace-nowrap` |
| `.btn-primary` | ink fill + surface text; hover `#000` |
| `.btn-secondary` | surface fill + 1px line stroke + ink text; hover stroke becomes ink |
| `.btn-quiet` | Transparent, ink-2 text |
| `.btn-danger` | Transparent + danger text + danger-line stroke |
| `.btn-sm` | Height 28px, 12.5px |
| `.field` | input/select/textarea: height 34px (40–44 on phone), surface background, 1px line, 2px corners, 13px; placeholder ink-3 |
| `.chip` / `.chip-on` | Filter toggle: transparent + line stroke → on state ink fill + surface text; can carry a "×" |
| `.seg` | View toggle segmented control: surface background + line stroke, 32×32 per button, active ink fill |
| `.tag` | Status tag: mono 10.5–11px, `px-1.5 py-0.5`, square corners. Generating = warn background + black text; failed = danger background + white text; finished = ink background + white text; serializing = surface + line stroke |
| `.read-mark` | `✓ 已读`: mono 10.5px, ok color |
| `.unread-dot` | 7px orange dot + "未读" |
| `.toast` | ink background + surface text, 2px corners, shadow, an 8px color square on the left (ok/warn/danger) |
| `.cover` | Book cover container: `aspect-[2/3]`, `overflow-hidden`, `box-shadow:0 0 0 1px rgb(20 20 20 / .08)`, square corners |
| `.cover-gen` | Generated cover, see §3 |

---

## 3. Generated covers (books without a cover)

Structure (**padding must sit on the inner layer**: `cqi` resolves against the nearest ancestor container, so putting it on the container itself makes it resolve against the viewport and the title gets pushed out of view — this bug already happened once in the prototype):

```html
<div class="cover cover-gen cover-tone-{{ tone }}">   {# container-type:inline-size; position:relative #}
  <div class="cover-gen-inner">                       {# absolute inset-0; padding 11cqi 10cqi 9cqi; flex col justify-between #}
    <div><div class="cover-gen-rule"></div><div class="cover-gen-title">{{ book.title }}</div></div>
    <div class="cover-gen-author">{{ book.author or "" }}</div>
  </div>
</div>
```

- Rule: `width:20cqi; height:max(2px,1.4cqi); background:currentColor; margin-bottom:8cqi`
- Title: 700, `font-size:15cqi`, `line-height:1.18`, `letter-spacing:-.02em`, `overflow-wrap:anywhere`, **clamped to 4 lines**
- Author: mono, `font-size:max(9px,7cqi)`, `opacity:.75`, single line with ellipsis
- Five tones (background / text): `#141414/#FAFAF8`, `#8C8A84/#141414`, `#D6D6D1/#141414`, `#3A3A38/#FAFAF8`, `#BDB8AD/#141414`
- Stable mapping: `{% set tone = (book.book_id[:2] | int(0, 16)) % 5 %}`
- **Small thumbnails (≤ 56px wide, i.e. phone list)**: don't show the title; show the rule + the title's first character (`book.title[:1]`, 700, `44cqi`)
- Desktop list thumbnails are 72×108: show the title, no author
- Replace the current gray "B" placeholder everywhere (cover wall, list, detail page, edit page)

Real covers: `object-cover` laid flat, with the same 1px faint stroke. **No more** `group-hover:scale-105` zoom.

---

## 4. Global layout (`templates/base.html`)

### Desktop (≥ 768px)
- Content container `max-w-[1376px] mx-auto px-8` (`px-4` on phone)
- Header: height 52px, background same as the page, **only one bottom `line` hairline**, no shadow
  - Left: mark (14px black square + 6px orange dot at top-right, see the `.mark` in the prototype) + "Bindery" 16/700
  - Nav: 书库 入库 任务 追踪 规则 归档, 13.5px ink-2; current item ink + 600 + a 2px orange line at the bottom (pressed onto the header hairline)
  - Right: "退出" quiet button in ink-3
  - Remove the "本地书库" pulsing pill
- Update `static/logo.svg` to the new mark (favicon too)

### Phone (< 768px)
- Header: height 48px, only the mark + "Bindery"; the nav row is hidden
- **Fixed bottom tab bar** (`md:hidden`): 5 equal columns 书库 / 入库 / 任务 / 追踪 / 更多; icon 21px + 10.5px label; current item ink + 600 + 2px orange line at the top; surface background + top `line` hairline; height 56px + `env(safe-area-inset-bottom)`
- "更多" opens an **Alpine bottom sheet** (no new backend route): rows "规则与主题" (/rules), "归档" (/archive), and "退出登录" (danger text, submits a POST to the existing `/logout`); each row ≥ 56px tall. While the sheet is open, the "更多" tab shows as active. Visual reference: `MMore.dc.html`
- `main` gets a bottom padding that clears the tab bar
- The toast moves to the top on phone with 16px side gutters

---

## 5. Pages

### 5.1 Library `index.html` + `partials/library_section.html` + `partials/book_card.html`
- **Merge the title into the toolbar row** (refer to Main/List): `书库` 22/700 + mono count (`N 册`; when the unread filter is on, `N 册 · 仅未读`) + search field (`flex:0 1 300px`) + sort select + "仅看未读" chip + spacer + view seg + "多选" + primary "+ 入库". The row wraps.
- Remove the separate "毗连设置" bulk-settings panel and the "已入库 N 本 /library" row
- "多选" toggles into an on-state chip ("多选中"). Bulk actions move to the **floating bar**:
  - Desktop: fixed bottom, horizontally centered, ink background: `已选 N 册` (N in orange mono) | 全选本页 清空 | 批量下载 批量归档 (accent-soft text) | 完成 (surface fill + ink text)
  - Phone: docked at the bottom over the tab bar, two rows. Top: count + 全选本页 / 清空 / 完成; bottom: two equal columns 批量下载 / 批量归档, 44px tall
  - Selected cards/rows: `accent-50` background (list) or a 2px ink outer stroke (cover wall); checkbox `accent-color: var(--color-accent)`
- Cover wall: `grid-template-columns: repeat(auto-fill, minmax(136px, 1fr))`, `gap: 28px 20px` (change `grid-cols-auto-180` to a 136 version, and change the 180 in `computeGridColumnCount` to 136)
  - Card = cover + below it title (13.5/600, single-line ellipsis) + author row (12px ink-3, `✓ 已读` on the right)
  - Status tags pinned to the cover's top-left corner, no margin
  - Hover / focus-within: the cover stroke becomes ink; a 32px **solid black** "阅读" bar slides up from the bottom (turns orange with black text on hover). No gradient overlay
  - **Do not nest `<a>`**: the cover's full-area detail link and the "阅读" link are siblings (that is the current structure, keep it)
- List view (desktop): table-like columns — checkbox (only in multi-select) | 72×108 thumbnail | title/author | publication (publisher · year) | format (mono) | updated (mono) | actions (阅读 secondary-sm, 下载 quiet-sm, 归档 quiet-sm danger text). Header row mono uppercase, with an ink rule under it; rows separated by line hairlines, `py-2.5`
- List view (phone, see MLibrary): 48×72 thumbnail (first-character mode) | title 15/600 + author 12.5 + mono `格式 · 日期 · ✓ 已读` | trailing "阅读" `btn-sm`. Tapping the row opens detail. **Hide 下载/归档 on phone** (moved to the detail page). Mobile still forces list (keep the existing `isMobileViewport() ? 'list'` logic; don't build the grid toggle drawn in the prototype's top-right corner)
- Phone floating "+ 入库" button: bottom-right, 16px above the tab bar, 44px tall, ink background; hidden in multi-select mode
- Pagination: left side mono `1–16 / 32` (built from existing variables), right side 上一页 (quiet) · `1 / 2` mono · 下一页 (secondary); a line hairline above it
- Empty state: centered "书库还是空的" 15/600 + supporting text + primary button "入库第一本书" → /ingest

### 5.2 Book detail `book.html` + `partials/meta_view.html` (refer to Book / MBook)
- Breadcrumb: `书库 / 书名` (12.5px ink-3, "书库" links to `return_to`)
- Desktop: left column 240px cover (+ below it mono `EPUB|TXT · 更新 日期`, only for fields that exist), right column info; gap 48px
- Info: mono label `书目` → title 32/700 → series (16px ink-2, when present) → `作者 | 语言 | ★ rating | unread dot/✓ 已读` separated by `|` in mute color
- Action row: `阅读` (primary, a little wider) `下载 EPUB` `标记已读/标记未读` `编辑` (all secondary) … right-aligned "归档" (quiet + danger text). "编辑" keeps the existing hx-get swap behavior
- Spec table: `dl` grid with 3 columns on desktop / 2 on phone, an ink rule above it, each cell `dt` 12px ink-3 + `dd` 14px with a line hairline under it; empty values render as mute "—"; dates and ISBN in mono. Fields: 系列 出版社 出版日期 ISBN 标签 来源 规则模板 状态 (plus 入库/更新时间 when present in the book data)
- Description: 12px ink-3 label + 14.5/1.85 body, `max-w-[720px]`
- Bottom: "重新生成" and "永久删除" side by side in two columns (stacked on phone), each with a line hairline above; delete uses `btn-danger`; keep the confirm
- Phone: cover 112×168 on the left + title/author/rating on the right; below, `阅读` full-width 44px, then `下载 EPUB` / `标记已读` in two columns; "编辑" goes into the top-right of the top bar; 归档 / 永久删除 in two columns at the very bottom
- `partials/meta_edit.html` (edit mode): the same two-column skeleton; fields use `.field`, star rating uses orange, metadata-candidate list uses line-hairline rows; the cover area uses the generated cover

### 5.3 Login `login.html` (refer to Login)
- Centered 340px column, no card: mark + "Bindery" 26/700 → mono `PRIVATE LIBRARY · TXT → EPUB` → ink rule → "密码" label + 42px field + 42px black "登录" button
- All copy in Chinese (placeholder "输入访问密码"); error / unconfigured-hash notices as danger / warn-colored text with a 2px left color block

### 5.4 Other pages (apply the system; no prototype boards, follow these rules)
Common to all: page head uses the same "title 22/700 + mono meta + actions in one row" pattern; remove all `bg-white rounded-xl shadow-sm border` cards and switch to "section title 15/600 + content", separating sections with line hairlines; forms use `.field` / `.btn-*`.
- **入库 `ingest.html` + `partials/upload_preview.html`**: the drop zone uses a 1px dashed ink-3 border, 2px corners, surface background, turning `accent-50` background + accent border on drag-over; no circular icon background. Template selection, advanced CSS (`<details>`) and the preview list use line-hairline rows
- **任务 `jobs.html` + `partials/jobs_section.html`**: table style (mono header + ink rule); status uses `.tag`; actions are `btn-sm`. Phone: each job is a two-line row
- **追踪 `wishlist.html`**: the filter toolbar wraps; the table is wrapped in `overflow-x-auto` (it currently overflows at 800px width); status/read state uses `.tag` / `.read-mark`; stars in orange; translate English copy to Chinese ("Search title, author, tag…" → "搜索书名、作者、标签", Clear → 清除, Filter → 筛选, Export CSV → 导出 CSV); modals use surface background + 2px corners + shadow + ink-color mask `rgb(20 20 20 / .4)`. Phone: table rows become two-line rows (title + mono status/rating), with actions folded into the end of the row
- **规则 `rules.html` + `partials/rule_editor.html` `theme_editor.html` `rules_preview.html`**: left list / right editor; textareas/code areas use the mono font + surface background; the current item is marked with a 2px orange line on the left (this is the only place the left-line style is allowed). Phone: stacked vertically
- **归档 `archive.html`**: same as the library list view; actions are 恢复 (secondary) / 彻底删除 (danger), with bulk actions reusing the floating bar style

### 5.5 Out of scope
- **Reader `templates/preview.html` — do not change it at all** (it has its own reading backgrounds / dim mode)
- Dark mode
- EPUB content themes (`bindery-templates/themes`)

---

## 6. Copy
- Count unit is "册"; "本" is no longer used
- Remove the meaningless "毗连设置" label, the `/library` debug text and the "本地书库" pill
- All UI text in Chinese; product name stays "Bindery"
