import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../client/devices/fs";
import { Button, Checkbox, Select } from "../../ui";
import { Link } from "../../shared/spa-link";
import { ChapterFrame } from "../kindle/typeset/frames";
import { PreviewBookPicker } from "../kindle/typeset/book-picker";
import { useOptionalDevice } from "./context";
import { SendToDevice } from "./send-to-device";
import { KOBO_LINE_HEIGHT_RANGE, KOBO_PREVIEW_DEFAULTS, KOBO_SCALE_RANGE, koboPreviewCss, koboPreviewEstimate, koboPreviewGeometry, koboPreviewSettings, type KoboPreviewSettings } from "./kobo-page";
import { EMPTY_SETTINGS } from "../../client/devices/profiles";

const STORAGE_KEY = "bindery.kobo.preview";
/** Per-browser convenience only: storage can be unavailable (private windows, blocked site data). */
function loadSettings(): KoboPreviewSettings {
  try { return koboPreviewSettings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")); } catch { return KOBO_PREVIEW_DEFAULTS; }
}
function storeSettings(settings: KoboPreviewSettings) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Preview still works without persistence. */ }
}
import { previewContentUrl, type PreviewChapter, type PreviewData } from "../kindle/typeset/model";

export function KoboPreviewPage(props: { data: PreviewData; chapters: (bookId: string) => Promise<PreviewChapter[]> }) {
  const [bookId, setBookId] = createSignal(props.data.bookId), [sections, setSections] = createSignal(props.data.sections), [chapter, setChapter] = createSignal(0);
  const [start, setStart] = createSignal({ page: 1 }), [loading, setLoading] = createSignal(false), [error, setError] = createSignal(props.data.error);
  const [stripFonts, setStripFonts] = createSignal(false), [stripImages, setStripImages] = createSignal(false), [stripMargins, setStripMargins] = createSignal(false);
  // Defaults render on the server; stored settings apply after mount so hydration matches.
  const [settings, setSettings] = createSignal(KOBO_PREVIEW_DEFAULTS), [restored, setRestored] = createSignal(false);
  onSettled(() => { setSettings(loadSettings()); setRestored(true); });
  createEffect(() => ({ value: settings(), restored: restored() }), ({ value, restored }) => { if (restored) storeSettings(value); });
  const edit = (patch: Partial<KoboPreviewSettings>) => setSettings(current => koboPreviewSettings({ ...current, ...patch }));
  const device = useOptionalDevice();
  const fontDevice = () => device?.ready() && device.state().status === "granted" ? device.state().device : null;
  const fonts = () => fontDevice() ? device?.inventory()?.fonts ?? [] : [];
  const family = () => fonts().find(font => font.name === settings().font);
  const geometry = createMemo(() => koboPreviewGeometry(settings())), css = createMemo(() => koboPreviewCss(settings())), estimate = () => koboPreviewEstimate(settings());
  let disposed = false, request = 0;
  function openChapter(index: number, page = 1) { setChapter(index); setStart({ page }); }
  createEffect(() => props.data, data => { request++; setBookId(data.bookId); setSections(data.sections); openChapter(0); setLoading(false); setError(data.error); });
  onCleanup(() => { disposed = true; request++; });
  async function chooseBook(id: string) {
    const current = ++request; setBookId(id); setSections([]); openChapter(0); setLoading(true); setError("");
    try { const result = await props.chapters(id); if (!disposed && current === request) setSections(result); }
    catch (failure) { if (!disposed && current === request) setError(errorMessage(failure)); }
    finally { if (!disposed && current === request) setLoading(false); }
  }
  const src = () => {
    const section = sections()[chapter()];
    return section ? previewContentUrl(bookId(), section.item_path, { stripFonts: stripFonts(), stripImages: stripImages(), stripPageMargins: stripMargins() }) : "";
  };
  return <section class="kt-page" aria-label="排版与预览">
    <div class="kt-preview-layout"><section class="kt-editor" aria-label="Kobo 传书选项">
      <div class="kt-editor-heading"><h2>Kobo 近似预览</h2><p class="muted">看书籍自带排版在 Kobo 上的大致效果。字号、行距和页边距由 Kobo 阅读设置决定，这里按 Libra 2 的一组实测设置模拟。</p></div>
      <div class="kt-range"><label for="kobo-scale">字号</label>
        <input id="kobo-scale" type="range" min={KOBO_SCALE_RANGE.min} max={KOBO_SCALE_RANGE.max} step={KOBO_SCALE_RANGE.step} value={settings().scale} onInput={event => edit({ scale: Number(event.currentTarget.value) })} />
        <span class="kt-range-value"><output for="kobo-scale">{Math.round(settings().scale * 100)}%</output></span></div>
      <div class="kt-range"><label for="kobo-line-height">行距</label>
        <input id="kobo-line-height" type="range" min={KOBO_LINE_HEIGHT_RANGE.min} max={KOBO_LINE_HEIGHT_RANGE.max} step={KOBO_LINE_HEIGHT_RANGE.step} value={settings().lineHeight} onInput={event => edit({ lineHeight: Number(event.currentTarget.value) })} />
        <span class="kt-range-value"><output for="kobo-line-height">{settings().lineHeight.toFixed(2)} 倍</output></span></div>
      <Select label="字体" value={settings().font ?? ""} onChange={event => edit({ font: event.currentTarget.value || null })}>
        <option value="">书籍自带字体</option>
        <Show when={settings().font && !family()}><option value={settings().font!}>{settings().font}（当前设备未读取到）</option></Show>
        <For each={fonts()}>{font => <option value={font.name}>{font.name}</option>}</For>
      </Select>
      <Show when={settings().font && !family()}><p class="muted">所选字体当前不可用，预览暂用无衬线字体代替。连接 Kobo 并在<Link href="/devices/fonts">字体</Link>页安装后即可预览。</p></Show>
      <p class="muted" data-kobo-estimate>无样式正文约每行 {estimate().charsPerLine} 字、每页 {estimate().linesPerPage} 行。字号 100%、行距 1.54 倍时与 Libra 2 实测一致；其他取值只是近似，不对应 Kobo 滑块的具体档位。</p>
      <Button variant="quiet" class="kindle-text-button" disabled={settings().scale === KOBO_PREVIEW_DEFAULTS.scale && settings().lineHeight === KOBO_PREVIEW_DEFAULTS.lineHeight && !settings().font} onClick={() => setSettings(KOBO_PREVIEW_DEFAULTS)}>恢复实测设置</Button>
      <div class="kt-checkboxes" role="group" aria-label="传书选项">
        <Checkbox label="去掉书籍自带字体" checked={stripFonts()} onChange={event => setStripFonts(event.currentTarget.checked)} />
        <Checkbox label="去掉所有图片（保留封面）" checked={stripImages()} onChange={event => setStripImages(event.currentTarget.checked)} />
        <Checkbox label="去掉书籍自带页边距" checked={stripMargins()} onChange={event => setStripMargins(event.currentTarget.checked)} />
      </div>
      <SendToDevice bookId={bookId()} profileId="default" options={{ settings: { ...EMPTY_SETTINGS, stripFonts: stripFonts(), stripImages: stripImages(), stripPageMargins: stripMargins() } }} />
      <p class="muted">发送时使用上面勾选的选项，并覆盖设备上的旧版本。批量传书请到<Link href="/devices/transfer">传书页</Link>。</p>
    </section><section class="kt-preview kt-preview-sticky" aria-label="设备预览">
      <div class="kt-preview-header">
        <div class="kt-preview-toolbar"><div class="kt-preview-selectors">
          <PreviewBookPicker books={props.data.books} value={bookId()} disabled={!props.data.books.length} onChange={id => { void chooseBook(id); }} />
          <Select label="章节" value={String(chapter())} disabled={loading() || !sections().length} onChange={event => openChapter(Number(event.currentTarget.value))}><For each={sections()}>{(section, index) => <option value={String(index())}>{section.title}</option>}</For></Select>
        </div></div>
        <Show when={loading()}><p role="status">正在读取章节…</p></Show><Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
        <Show when={bookId() && error()}><Button variant="secondary" disabled={loading()} onClick={() => chooseBook(bookId())}>重新读取章节</Button></Show>
        <Show when={!props.data.books.length}><p class="notice">书库中还没有可预览的 EPUB。</p></Show>
        <Show when={bookId() && !sections().length && !loading() && !error()}><p class="notice">这本书没有可预览的章节。</p></Show>
      </div>
      <ChapterFrame src={src()} model="other" marginPreset="narrow" geometry={geometry()} label="Kobo" css={css()} device={family() ? fontDevice() : null} family={family()} start={start()}
        hasPrevious={chapter() > 0} hasNext={chapter() < sections().length - 1} onChapter={direction => openChapter(chapter() + direction, direction < 0 ? Number.MAX_SAFE_INTEGER : 1)} />
      <p class="muted">页边距按 Libra 2 最小档实测。书籍自带的字号、缩进和边距会改变字数；分页与真机会有少量差异，不模拟页眉页脚。</p>
    </section></div>
  </section>;
}
