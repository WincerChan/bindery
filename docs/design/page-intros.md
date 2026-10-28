# Page intro ownership and independent verification

## Contract and scope

`PageIntro` owns the introductory header, its one h1, back link slot, text stack,
actions/status slots, visual-slot placement, and gap to the next block.
`src/styles.css` owns numeric intro values; `src/ui/ui.css` selects semantic
variants and consumes tokens. Feature styles may style **content** (book artwork,
device shells, progress bars, controls), not the shared slots, their typography,
or `--intro-*` assignments. An intro class is not permission to override h1.

This is not a claim that every page must have the same outline or height. Main
pages share a rhythm; back-linked subpages, the connection instructions, book
metadata and the preview toolbar have different structures drawn in the boards.

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

## Independent token provenance

Sources: [README §3.2/3.3/3.5](README.md), §2.2 typography, §2.4 page whitespace,
and the **actual inline styles** in `prototype/*.dc.html`, not the earlier audit.
Names below omit `--intro-`. Values are desktop → phone unless stated otherwise.
Zero resets, `normal`, flex growth/shrink factors, and grid placement are structural,
not additional spacing scales.

| Tokens / structure | Values | Evidence / rationale |
| --- | --- | --- |
| `pad-top`, `stack-gap`, `actions-offset` | 40/22/6 → 0/16/0 | Main, Ingest, Tracker; MobileIngest/Tracker/Vocabulary. Shell already supplies top 40/28. |
| `title-size/weight/line` | `text-hero` = 46/600/1.25 → 30/600/1.3 | Main h1 and phone h1; README §2.2. |
| `title-tracking`, `cover-title-tracking` | normal; .01em → normal | Main explicitly tracks its title; other main boards do not. Do not spread the cover exception to all titles. |
| `eyebrow-size/tracking/line` | 14/.08em/normal → 13/.08em/normal | Main/phone small statistics. Their boards inherit normal, not the app body's1.5; measured20/19px line boxes with Noto Sans. |
| `lead-size/line/max` | 15/1.85/520 → 15/1.8/520 | Main and MobileLibrary paragraphs. |
| `action-gap`, `status-gap/offset` | 12 → 10; 8px 14px / 0 | Main/MobileLibrary controls; Vocabulary status paragraph. |
| `text-basis`, `row-gap`, `visual-gap` | 380 / 56 / stack-gap | Main text flex-basis and section gap; phone single-column stack. Tracker uses section-gap before its reading visual on phone. |
| `gap-next` | section = 48 → 32 | README page-whitespace rule; main mobile boards. Some desktop boards draw 52: normalized deliberately, not falsely described as an exact match. |
| `visual-cover/page/reading` | 420/580/440 | Main/Ingest/Tracker outer visual flex bases. Fallback visual uses cover size. |
| `cover-pad`, `reading-pad` | 12px 0 → 6px 0 0 / 0 | Main/Tracker visual padding; MobileLibrary cover top inset. |
| `cover-column`, `cover-lead-gap` | 92; stack-gap → 12 | MobileLibrary explicitly nests title/description at 12, inside an outer 16 stack. |
| `visual-vocabulary`, `vocabulary-basis/inset/visual-offset` | 561; 360/24/0 → 360/0/12 | Vocabulary: 520 content + 40 left padding + 1 rule = 561 border-box; right margin24. MobileVocabulary quote inset12. Phone visual spans full width. |
| `wide-lead` | 560 | Vocabulary and SettingsRules/Themes max-width. |
| `visual-device`, `device-inset` | 300 / 40 → 300 / 0 | Devices and DevicesConnect figure width300 plus right margin40. Margin belongs to the shared slot, not a feature override. |
| `empty-pad/lead` | 52/600 → 0/600 | IngestEmpty hero and paragraph; no empty-phone board, mobile uses §3.5. |
| `subpage-pad/stack/next`, `back-gap` | 24/16/36; 16 → 0/16/32; 16 | SettingsRules and SettingsThemes sections and main gap. Their stack is **16**, not22. |
| `title-only-next` | 40 → 32 | SettingsHub main gap; MobileSettings. |
| `split` | subpage-pad; shared stack/back-gap22 →16; next0 | SettingsSecurity's back/title/paragraph stack22. Its keys panel is beside the intro; the parent owns the 48px column gap and phone32px row gap. |
| `guide-stack/next/actions/basis` | 28/56/16/420 →16/32/16/420 | DevicesConnect left stack, main gap, controls and text flex-basis. `/devices/connect` additionally retains its functional back link. |
| `book-back/stack/row/column/text-pad` | 28/20/64/268/8 →20/14/20/268/0 | BookDetail outer/back/text stacks. Cover column is 260 + 8 inset. MobileBookDetail stack14, not16 or22; actual phone artwork168 remains content-owned. |
| `book-next/lead/line/status/actions` | 56/620/1.9/10/8 →32/620/1.85/6/8 | BookDetail/MobileBookDetail paragraph and status/action margins. Status and metadata are intervening rows, not unexplained lead/action spacing. |
| `topbar-gap/title/line/title-margin/next` | 10/30/normal/`0 12px 0 14px`/32 | DevicesPreview topbar. `topbar-back-pad`8 matches its back link. Controls share its flex wrapping context (`display: contents` only on the nonsemantic action wrapper). Phone shows MobileDevices instead. |
| `editor-title/line` | text-heading26/1.3 | No standalone editor board. Retains the existing form-toolbar typography and44px controls, consistent with README §2.2 and control specification. No invented large hero. |
| `compact` | subpage-pad24; title-only-next40; visually hidden h1 | DevicesFonts deliberately collapses the hero to a status masthead. Added an accessible h1 and font-management h2 without changing the board's visible structure. |
| `action-dock-inset/pad/layer` | 69 / 12px 16px / 25 | Retains staged ingest's existing phone action dock above the 69px navigation bar. Exposed as `mobileActions="dock"`, not an alias that lets feature CSS position a shared action slot. This functional exception differs from MobileIngest's inline controls. |

Book layout ignores the cover-size modifier: otherwise MobileLibrary's 12px lead
gap and grid row-gap leak into MobileBookDetail and override its14/20px stacks.

## Refuted claims and fixes

The earlier “no feature overrides / all boards use22 desktop and16 phone” claim
was false. Feature custom-property assignments (empty ingest, tracker, library,
vocabulary, security, connect), direct visual-slot overrides and preview h1 rules
survived the original selector test. The editor also still authored its own h1.
These were removed/migrated, not merely renamed as intro overrides.

Fixed rules/themes16, guide28, book20/14, library phone nested12, security back22,
preview30px type and wrapping, vocabulary's desktop shared status/control row,
and cover-only letter spacing. Board normal line-height was restored for eyebrow/preview rather than assuming1.5. Added compact-fonts semantics and fixed preview's h1→h3 skip. AX-tree checks also exposed a hidden desktop transfer modal making the phone intro inert; the transfer sheet now closes below768px, including on resize. Artwork selectors
now target their own content (e.g. `.library-hero-cover`), not `.ui-page-visual`.

Populated quote/reading fixtures also exposed desktop visual flex bases becoming
fixed **phone heights** (561px vocabulary / 580px ingest). Shared phone slots now
reset `flex: none`; content determines height and the column stretches its children
rather than shrink-wrapping grid artwork. The staged-ingest action dock was
another hidden alias override and now belongs to the shared API/CSS/tokens.

Regression tests cover numeric token ownership, feature aliases/custom-property
bypasses, actual board-style provenance, isolated book/cover structures, preview
wrap ownership and exactly one h1 per rendered variant.

## Verification limits and deliberate differences

- Stable text tops (`align-items: flex-start`, visual independently centered) are
  intentional unification. Desktop boards often vertically center text against
  the artwork, so their absolute text y can differ. Typography and local stack
  distances must not change with artwork height. Desktop board screenshots also
  include32px presentation framing and36px main padding, versus the app's40px
  shell padding: compare normalized coordinates, not raw screenshot y values.
- Section48 is the README standard even where a particular desktop board uses52.
  Real structural exceptions (rules36, hub40, guide/book56, preview32) are preserved.
- Real library titles, descriptions, vocabulary configuration/status and preview
  picker contents differ from the boards' fixed sample copy. These change wrapping
  and block height, not the shared rhythm. Staged phone ingest retains its functional
  fixed action dock above navigation; its lead-to-action distance depends on viewport
  height, not a 491px CSS gap. It is not a pixel match for MobileIngest's inline controls.
- Board-comparison captures inject the boards' Noto Sans/Serif web fonts into the
  test page only; production still uses its existing system-font stacks. A separate
  unmodified-font run checks all routes too, but `fc-list :lang=zh` confirms this
  environment has no installed CJK fonts: native captures cannot prove glyph fidelity.
  `normal` line boxes and wrapping vary
  with the installed fallback; comparison coordinates are not universal OS values.
- Screenshot files were captured for app and boards. **This model's image reader
  reported that images cannot be displayed. No visual/pixel-perfect sign-off is
  claimed.** Geometry, computed styles, line counts and accessibility DOM were
  checked independently in Chromium, including the accessibility tree. The desktop
  transfer modal intentionally exposes its named h2/dialog rather than the inert
  underlying main/h1. Human screenshot inspection remains required.
- Per-route/per-width results and exact check counts: [intro-check-results.md](intro-check-results.md).
- Device-connected measurements use an isolated OPFS-backed directory with a
  Kindle identity and empty inventory, not physical hardware. Disconnected and
  phone states are also measured. No production device/library is modified.

