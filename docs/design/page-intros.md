# Page intro rhythm and structure

## Contract and scope

`PageIntro` owns the introductory header: its one h1, back-link slot, text stack,
status/action slots, visual-slot placement and gap to the next block. `src/styles.css`
owns numeric intro values; `src/ui/ui.css` selects semantic variants and consumes
tokens. Feature styles may style **content** (book artwork, device shells, progress
bars, controls), not the shared slots, their typography, or `--intro-*` assignments.
An intro class is not permission to override h1.

There is **one text rhythm for every page intro at every breakpoint**:

- Desktop: `--intro-stack-gap` 22px for eyebrow → title → lead, and the same 22px
  between lead content and an intervening status/content row. The action row adds
  `--intro-actions-offset` 6px, so it sits 28px below the previous stack item.
- Phone: `--intro-stack-gap` 16px with no extra action offset.
- `PageIntro` variants and page classes may change **structure** only: a back link
  above the stack (with smaller top padding), title-only, the preview topbar
  (30px title row), visual-slot size/placement, a cover beside the title, or a
  steps list instead of a lead. They must not change the stack gap, the action
  offset, or the eyebrow/title/lead type.
- Structural spacing stays with its structure: shell/back-link top padding, the
  back-link-to-stack gap, the text/visual row gap, the book cover column, and the
  gap to the next block (`--intro-gap-next`).

The topbar is the one explicit type exception: the typeset preview keeps its
30px title in a horizontal row. The title-only and editor rows keep their
structural layouts but use the shared intro title type.

Routes audited:

- `/`, `/ingest` (empty/staged), `/tracker`, `/vocabulary`: main intro.
- `/devices`: main when connected; guide when disconnected. `/devices/transfer`
  shares that device intro. `/devices/connect`: guide with a functional back link.
- `/devices/preview`: topbar; `/devices/fonts`: compact device masthead.
- All device routes on phones: the same mobile explanatory intro, not the hidden
  desktop UI. Exactly one **exposed** h1; responsive alternatives remain in DOM.
- `/settings`: title-only; `/rules`, `/themes`: subpage; `/security`: split.
- `/book/:id`: book; `/book/:id/edit`: editor toolbar.
- Rule/theme editor URLs retain their underlying catalog intro and open an editor
  overlay. Archive, jobs, wishlist and legacy kindle/device-vocabulary routes are
  aliases/redirects or overlays, not additional intro designs.
- Login intentionally retains `PageHeader`: it is an unauthenticated, centered
  authentication form, outside the editorial shell in README §3.2/3.3. The reader,
  error/not-found views and dialog headings are not editorial page intros.

## Shared rhythm tokens

Sources: [README §3.2/3.3/3.5](README.md), §2.2 typography, §2.4 page whitespace,
and the corrected intro spacing in `prototype/*.dc.html`. Names below omit
`--intro-`. Values are desktop → phone unless stated otherwise.

| Tokens / structure | Values | Evidence / rationale |
| --- | --- | --- |
| `stack-gap` | 22 → 16 | One value for every eyebrow/title/lead/status/content/action stack. Main, subpages, guide, book and phone boards all draw it. |
| `actions-offset` | 6 → 0 | Every separate action row adds exactly 6px on desktop, none on phone. The vocabulary status+actions row is structural and has no second stack step. |
| `action-gap` | 12 → 10 | Horizontal gap inside an action row; not a stack gap. |
| `status-gap`, `status-offset` | 8px 14px / 0 | Status rows use the shared stack, with no per-page extra offset. |
| `pad-top`, `back-gap`, `gap-next` | 40/16/section → 0/16/32 | Main intro shell; back-link gap and README section spacing are structural. |
| `title-size/weight/line/tracking` | `text-hero` = 46/600/1.25/.01em → 30/600/1.3/normal | Shared intro title type. Topbar keeps its explicit 30px row. |
| `eyebrow-size/tracking/line` | 14/.08em/normal → 13/.08em/normal | Shared eyebrow type. Boards inherit `normal`, not the app body's 1.5. |
| `lead-size/line` | 15/1.85 → 15/1.8 | Shared lead type. Book/guide/subpage intros do not get a different line-height. |
| `lead-max` | 520 main; 560 subpage/vocabulary; 620 book | Text-column measures, not type or rhythm. They only bound line length. |
| `text-basis`, `row-gap`, `visual-gap` | 380 / 56 / stack-gap | Main text basis and desktop text/visual gap; phone single-column stack. Tracker uses section-gap before its reading visual on phone. |
| `visual-cover/page/reading/vocabulary/device` | 420/580/440/561/300 | Visual-slot sizes are structural and may differ by page. |
| `cover-pad`, `reading-pad`, `device-inset` | 12px 0 → 6px 0 0 / 0; 40 → 0 | Padding/margin belonging to the visual slot, not the text stack. |
| `cover-column` | 92 | MobileLibrary/BookDetail cover-beside-title column. |
| `subpage-pad/next` | 24/36 → 0/32 | SettingsRules/Themes back-link structure and next-block gap. Their old 16px stack is gone. |
| `title-only-next` | 40 → 32 | SettingsHub/MobileSettings next-block gap; no stack content. |
| `split` | subpage-pad; back-gap stack-gap; next 0 | SettingsSecurity's back/title/paragraph stack uses the shared 22 → 16 rhythm. |
| `guide-next/basis` | 56/420 → 32/420 | DevicesConnect next-block gap and text basis. The steps list is structural; its stack/action rhythm is shared. |
| `book-back/row/column/text-pad` | 28/64/268/8 → 20/20/268/0 | Back-link gap, cover column and cover/text row are structural. Book text uses the shared 22 → 16 stack and shared lead type. |
| `book-next` | 56 → 32 | BookDetail/MobileBookDetail next-block gap. No book-only status/action offsets. |
| `topbar-gap/title/line/title-margin/back-pad/next` | 10/30/normal/`0 12px 0 14px`/8/32 | DevicesPreview's structural 30px row; controls share its wrapping context. Phone shows MobileDevices instead. |
| `compact` | subpage-pad; title-only-next; visually hidden h1 | DevicesFonts deliberately collapses the hero to a status masthead. |
| `action-dock-inset/pad/layer` | 69 / 12px 16px / 25 | Staged ingest's functional phone action dock above navigation. Exposed as `mobileActions="dock"`. |

The book layout ignores the cover-size modifier, so the mobile cover grid cannot
leak its cover column or gaps into the book text stack. Book/guide/subpage no
longer carry their own stack, status or action spacing tokens.

## Removed rhythm/type drift

The earlier “restore board-specific intro rhythms” change treated drawing drift
as intent. Removed from production tokens/CSS:

- subpage stack 16, guide stack 28, book stack 20/14, MobileLibrary title→lead 12;
- book status/action offsets 10/8 and 6/8, guide/vocabulary action offsets 0,
  guide action gap 16;
- book lead line-height 1.9/1.85 and title tracking `normal`, cover-only title
  tracking, editor title 26px/1.3.

All of these now use the shared values above. The only remaining variant type
exception is the preview topbar's 30px row; all other variants keep the shared
intro title and lead type.

Feature custom-property assignments, direct visual-slot overrides and preview h1
rules were already removed/migrated, not merely renamed. Regression tests cover
numeric token ownership, feature aliases/custom-property bypasses, actual board
spacing, isolated book/cover structures, preview wrap ownership and exactly one
h1 per rendered variant.

## Verification limits and deliberate differences

- Stable text tops (`align-items: flex-start`, visual independently centered) are
  intentional unification. Desktop boards often vertically center text against
  the artwork, so their absolute text y can differ. Typography and local stack
  distances must not change with artwork height. Desktop board screenshots also
  include 32px presentation framing and 36px main padding, versus the app's 40px
  shell padding: compare normalized coordinates, not raw screenshot y values.
- Section 48 is the README standard even where a particular desktop board uses 52.
  Structural next-block exceptions (rules 36, hub 40, guide/book 56, preview 32)
  are preserved.
- Real library titles, descriptions, vocabulary configuration/status and preview
  picker contents differ from the boards' fixed sample copy. These change wrapping
  and block height, not the shared rhythm. Staged phone ingest retains its functional
  fixed action dock above navigation; its lead-to-action distance depends on viewport
  height, not a CSS stack gap. It is not a pixel match for MobileIngest's inline controls.
- Board-comparison captures inject the boards' Noto Sans/Serif web fonts into the
  test page only; production still uses its existing system-font stacks. Native
  captures cannot prove glyph fidelity where CJK fonts are unavailable.
- Device-connected measurements use an isolated OPFS-backed directory with a
  Kindle identity and empty inventory, not physical hardware. Disconnected and
  phone states are also measured. No production device/library is modified.
