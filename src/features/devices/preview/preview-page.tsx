import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { errorMessage } from "../../../client/devices/fs";
import { deviceKindLabel, kindleModelInfo, koboModelInfo, modelShortName, type DeviceKind } from "../../../client/devices/models";
import { defaultProfile, EMPTY_SETTINGS, generateProfileCss, profileSettings, type ProfileSettings, type TypesettingProfile } from "../../../client/devices/profiles";
import {
  READING_LINE_HEIGHT_RANGE, READING_SCALE_RANGE, convertMarginX, defaultReadingSettings, devicePresets, marginXPx, pageGeometry,
  previewEstimate, previewTarget, readingSettings, type DeviceReadingSettings,
} from "../../../client/devices/typeset";
import type { PairedDevice } from "../../../client/devices/identity";
import type { FontFamily } from "../../../client/devices/fonts";
import { validateCss } from "../../../core/css";
import { Button, Checkbox, ConfirmDialog, Dialog, Select, Textarea, TextField } from "../../../ui";
import { Link } from "../../../shared/spa-link";
import { DeviceProvider, useOptionalDevice } from "../context";
import type { DeviceManager } from "../../../client/devices/device";
import { SendToDevice } from "../send-to-device";
import { PreviewBookPicker } from "./book-picker";
import { ChapterFrame } from "./frames";
import { previewContentUrl, type PreviewChapter, type PreviewData } from "./model";

export interface ProfileApi {
  list(): Promise<TypesettingProfile[]>;
  create(profile: { name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  update(profile: { id: string; name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  delete(id: string): Promise<unknown>;
}
export interface ReadingApi {
  get(deviceId: string, kind: DeviceKind): Promise<DeviceReadingSettings>;
  save(deviceId: string, kind: DeviceKind, settings: DeviceReadingSettings): Promise<unknown>;
}
type Target = { id: string; kind: DeviceKind; model: string; name: string };
const ranges = [
  { key: "marginX", label: "左右边距调整", unit: "%", min: -10, max: 20, fallback: 0, step: 0.1 },
  { key: "lineHeight", label: "行高", unit: "", min: 1.2, max: 2.4, fallback: 1.6, step: 0.05 },
  { key: "paragraphSpacing", label: "段间距", unit: "em", min: 0, max: 1.5, fallback: 0, step: 0.1 },
  { key: "textIndent", label: "首行缩进", unit: "em", min: 0, max: 3, fallback: 2, step: 0.5 },
] as const;
const copyProfile = (profile: TypesettingProfile): TypesettingProfile => ({ ...profile, settings: { ...profile.settings } });
const modelOptions = (kind: DeviceKind) => kind === "kindle"
  ? Object.entries({ KPW3: kindleModelInfo("KPW3").name, KO3: kindleModelInfo("KO3").name, other: kindleModelInfo("other").name })
  : Object.entries({ libra2: koboModelInfo("libra2").name, libraH2O: koboModelInfo("libraH2O").name, sage: koboModelInfo("sage").name, elipsa: koboModelInfo("elipsa").name, claraHD: koboModelInfo("claraHD").name, clara2e: koboModelInfo("clara2e").name, claraBW: koboModelInfo("claraBW").name, claraColour: koboModelInfo("claraColour").name, libraColour: koboModelInfo("libraColour").name, nia: koboModelInfo("nia").name, forma: koboModelInfo("forma").name, auraOne: koboModelInfo("auraOne").name, auraH2O: koboModelInfo("auraH2O").name, auraEdition2: koboModelInfo("auraEdition2").name, aura: koboModelInfo("aura").name, glo: koboModelInfo("glo").name, touch: koboModelInfo("touch").name, mini: koboModelInfo("mini").name, unknown: koboModelInfo("unknown").name });
const defaultModel = (kind: DeviceKind) => kind === "kindle" ? "KPW3" : "libra2";

type PreviewProps = { data: PreviewData; initialFont?: string; profiles: ProfileApi; reading?: ReadingApi; chapters: (bookId: string) => Promise<PreviewChapter[]>; onDirty?: (dirty: boolean) => void; manager?: DeviceManager | null };
/** Allows isolated component tests to supply a manager without a surrounding provider. */
export function DevicePreviewPage(props: PreviewProps) {
  const context = useOptionalDevice();
  if (context || !props.manager) return <DevicePreviewPageInner {...props} />;
  return <DeviceProvider manager={props.manager}><DevicePreviewPageInner {...props} /></DeviceProvider>;
}
function DevicePreviewPageInner(props: PreviewProps) {
  const device = useOptionalDevice();
  const state = () => device?.state() ?? null;
  const remembered = () => device?.remembered() ?? [];
  const connected = () => state()?.status === "granted" ? state()!.device : null;
  const currentIdentity = () => state()?.device?.identity ?? null;
  const [target, setTarget] = createSignal<Target | null>(null), [modelKind, setModelKind] = createSignal<DeviceKind>("kindle"), [model, setModel] = createSignal("KPW3");
  const [reading, setReading] = createSignal<DeviceReadingSettings>(defaultReadingSettings("kindle"));
  const [profiles, setProfiles] = createSignal<TypesettingProfile[]>([]), [draft, setDraft] = createSignal<TypesettingProfile>(defaultProfile());
  const [baseline, setBaseline] = createSignal(JSON.stringify(defaultProfile()));
  const [fonts, setFonts] = createSignal<FontFamily[]>([]);
  const [busy, setBusy] = createSignal(false), [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const [saveAs, setSaveAs] = createSignal(false), [saveName, setSaveName] = createSignal(""), [deleting, setDeleting] = createSignal(false);
  const [bookId, setBookId] = createSignal(props.data.bookId), [sections, setSections] = createSignal(props.data.sections), [chapter, setChapter] = createSignal(0), [chapterStart, setChapterStart] = createSignal({ page: 1 });
  const [chapterLoading, setChapterLoading] = createSignal(false), [chapterError, setChapterError] = createSignal(props.data.error);
  let disposed = false, profileRequest = 0, chapterRequest = 0, initialFontApplied = false, readingRequest = 0, saveTimer: ReturnType<typeof setTimeout> | undefined, followedId: string | undefined, modelOnlyByUser = false;

  const previewName = () => target()?.name ?? `${deviceKindLabel(modelKind())} ${modelShortName(modelKind(), model())}`;
  const kind = () => target()?.kind ?? modelKind();
  const targetInfo = createMemo(() => previewTarget(kind(), target()?.model ?? model()));
  const geometry = createMemo(() => pageGeometry(targetInfo(), reading()));
  const presets = createMemo(() => devicePresets(kind(), targetInfo().panel));
  const connectedId = createMemo(() => connected()?.identity.id);
  const readingKey = createMemo(() => target()?.id ? `${target()!.id}:${kind()}` : `model:${kind()}`);
  const fontDevice = createMemo<PairedDevice | null>(() => { const current = connected(), selected = target(); return current && selected?.id === current.identity.id ? current : null; });
  const family = createMemo(() => fonts().find(value => value.name === draft().settings.fontFamily));
  const dirty = () => !draft().builtIn && JSON.stringify(draft()) !== baseline();
  const settings = () => profileSettings(draft().settings);
  const settingsError = () => { try { settings(); return ""; } catch (error) { return errorMessage(error); } };
  const cssError = () => validateCss(draft().settings.customCss);
  const css = () => settingsError() ? null : generateProfileCss({ ...draft(), settings: settings() });
  const immutable = () => draft().builtIn || busy() || loading();
  const canStore = () => !busy() && !loading() && !settingsError();
  const estimate = () => previewEstimate(geometry(), draft().settings);
  const overflow = () => estimate().sideMarginPx < geometry().side;
  const marginPercent = () => {
    const { marginX, marginXUnit } = draft().settings;
    return marginX === null ? null : Math.round(convertMarginX(geometry(), marginX, marginXUnit, "percent") * 10) / 10;
  };
  const marginText = () => { const { marginX, marginXUnit } = draft().settings; return marginX === null ? "默认" : `${marginX}${marginXUnit === "em" ? "em" : "%"}`; };
  const marginMin = () => Math.min(ranges[0].min, marginPercent() ?? 0), marginMax = () => Math.max(ranges[0].max, marginPercent() ?? 0);
  const rangeValue = (key: (typeof ranges)[number]["key"]) => key === "marginX" ? marginPercent() : draft().settings[key];
  const sendBlocked = () => {
    const current = connected(), selected = target();
    if (current && (!selected || selected.id !== current.identity.id)) return `预览的是 ${previewName()}，请切换到这台设备后发送。`;
    if (settingsError()) return settingsError();
    if (draft().settings.fontFamily && !fonts().some(font => font.name === draft().settings.fontFamily)) return `${deviceKindLabel(current?.identity.kind ?? kind())} 上未安装字体：${draft().settings.fontFamily}`;
  };
  const available = () => {
    const seen = new Set<string>(), list = remembered().map(value => value.identity);
    const current = currentIdentity();
    if (current && !list.some(value => value.id === current.id)) list.unshift(current);
    const selected = target();
    if (selected && !list.some(value => value.id === selected.id)) list.push({ id: selected.id, kind: selected.kind, model: selected.model, name: selected.name, created_at: "" });
    return list.filter(value => !seen.has(value.id) && Boolean(seen.add(value.id)));
  };
  function openChapter(index: number, page = 1) { setChapter(index); setChapterStart({ page }); }
  function selectProfile(profile: TypesettingProfile) { const selected = copyProfile(profile); setDraft(selected); setBaseline(JSON.stringify(selected)); setError(""); setNotice(""); }
  function edit<K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) { if (!immutable()) setDraft(old => ({ ...old, settings: { ...old.settings, [key]: value } })); }
  function editMargin(value: number | null) { if (!immutable()) setDraft(old => ({ ...old, settings: { ...old.settings, marginX: value, ...(value === null ? {} : { marginXUnit: "percent" as const }) } })); }
  function editReading(patch: Partial<DeviceReadingSettings>) { const value = readingSettings(kind(), { ...reading(), ...patch }); setReading(value); scheduleReadingSave(value); }
  function resetReading() { const value = defaultReadingSettings(kind()); setReading(value); scheduleReadingSave(value); }
  function scheduleReadingSave(value: DeviceReadingSettings) {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    const selected = target(), api = props.reading;
    if (!selected?.id || !api) return;
    saveTimer = setTimeout(() => { saveTimer = undefined; if (!disposed) void api.save(selected.id, selected.kind, value).catch(error => { if (!disposed) setError(errorMessage(error)); }); }, 500);
  }
  function chooseTarget(id: string) {
    if (busy()) return;
    const identity = available().find(value => value.id === id);
    modelOnlyByUser = !identity; followedId = undefined;
    setTarget(identity ? { id: identity.id, kind: identity.kind, model: identity.model, name: identity.name } : null);
  }
  function chooseModelKind(value: DeviceKind) {
    if (busy()) return;
    modelOnlyByUser = true; setModelKind(value); setModel(defaultModel(value)); setTarget(null);
    const fallback = defaultReadingSettings(value); setReading(fallback);
  }
  function openSaveAs() { setSaveName(draft().builtIn ? "我的排版" : draft().name); setSaveAs(true); }
  function reset() { if (!dirty() || window.confirm("当前排版有未保存的修改，确定放弃吗？")) selectProfile(JSON.parse(baseline()) as TypesettingProfile); }
  async function save(asNew = false) {
    if (!canStore()) return;
    if (!asNew && (draft().builtIn || draft().id === "draft")) { openSaveAs(); return; }
    setBusy(true); setError("");
    try {
      const current = draft(), value = settings(), input = { name: asNew ? saveName() : current.name, settings: value };
      const saved = asNew ? await props.profiles.create(input) : await props.profiles.update({ ...input, id: current.id });
      if (disposed) return;
      setProfiles(items => [...items.filter(item => item.id !== saved.id), saved]); selectProfile(saved); setSaveAs(false); setNotice("排版方案已保存，所有设备共用。");
    } catch (error) { if (!disposed) setError(errorMessage(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function remove() {
    const current = draft();
    if (current.builtIn || current.id === "draft" || busy()) return;
    setBusy(true);
    try {
      await props.profiles.delete(current.id);
      if (disposed) return;
      setProfiles(items => items.filter(item => item.id !== current.id)); selectProfile(defaultProfile()); setNotice("排版方案已删除。");
    } catch (error) { if (!disposed) setError(errorMessage(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function loadProfiles() {
    const request = ++profileRequest; setLoading(true); setError("");
    try {
      const items = await props.profiles.list();
      if (disposed || request !== profileRequest) return;
      setProfiles(items); selectProfile(items.find(item => item.builtIn) ?? defaultProfile());
      if (props.initialFont && !initialFontApplied) { initialFontApplied = true; setDraft({ id: "draft", name: "字体预览", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: props.initialFont } }); }
    } catch (error) { if (!disposed && request === profileRequest) { selectProfile(defaultProfile()); setError(errorMessage(error)); } }
    finally { if (!disposed && request === profileRequest) setLoading(false); }
  }
  async function chooseBook(id: string) {
    const request = ++chapterRequest; setBookId(id); setSections([]); openChapter(0); setChapterLoading(true); setChapterError("");
    try { const result = await props.chapters(id); if (!disposed && request === chapterRequest) setSections(result); }
    catch (error) { if (!disposed && request === chapterRequest) setChapterError(errorMessage(error)); }
    finally { if (!disposed && request === chapterRequest) setChapterLoading(false); }
  }
  createEffect(() => props.data, data => { chapterRequest++; setBookId(data.bookId); setSections(data.sections); openChapter(0); setChapterLoading(false); setChapterError(data.error); });
  createEffect(currentIdentity, identity => {
    if (!identity || modelOnlyByUser || (target() && target()!.id !== followedId)) return;
    followedId = identity.id; setTarget({ id: identity.id, kind: identity.kind, model: identity.model, name: identity.name });
  });
  createEffect(readingKey, () => {
    const selected = target(), request = ++readingRequest;
    if (!selected?.id || !props.reading) { setReading(defaultReadingSettings(kind())); return; }
    void props.reading.get(selected.id, selected.kind).then(value => { if (!disposed && request === readingRequest) setReading(value); }, error => { if (!disposed && request === readingRequest) { setReading(defaultReadingSettings(selected.kind)); setError(errorMessage(error)); } });
  });
  createEffect(() => fontDevice()?.identity.id, () => {
    const current = fontDevice();
    setFonts(current ? device?.inventory()?.fonts ?? [] : []);
  });
  createEffect(dirty, value => { props.onDirty?.(value); });
  onSettled(() => { void loadProfiles(); });
  onCleanup(() => { disposed = true; profileRequest++; chapterRequest++; readingRequest++; if (saveTimer !== undefined) clearTimeout(saveTimer); });
  const src = () => { const section = sections()[chapter()]; return section ? previewContentUrl(bookId(), section.item_path, settingsError() ? EMPTY_SETTINGS : draft().settings) : ""; };
  return <section class="kt-page" aria-label="排版与预览">
    <div class="kt-preview-layout"><section class="kt-editor" aria-label="排版方案编辑器">
      <div class="kt-editor-heading"><h2>排版方案</h2><p class="muted">所有设备共用一套排版参数；传书时写入副本，书库里的 EPUB 不变。</p></div>
      <Select label="预览设备" value={target()?.id ?? ""} disabled={busy()} onChange={event => chooseTarget(event.currentTarget.value)}>
        <option value="">仅预览型号</option>
        <For each={available()}>{identity => <option value={identity.id}>{identity.name} · {deviceKindLabel(identity.kind)} {modelShortName(identity.kind, identity.model)}</option>}</For>
      </Select>
      <Show when={!target()}><div class="kt-profile-controls">
        <Select label="设备种类" value={modelKind()} disabled={busy()} onChange={event => chooseModelKind(event.currentTarget.value as DeviceKind)}><option value="kindle">Kindle</option><option value="kobo">Kobo</option></Select>
        <Select label="预览型号" value={model()} disabled={busy()} onChange={event => setModel(event.currentTarget.value)}><For each={modelOptions(modelKind())}>{([id, name]) => <option value={id}>{name}</option>}</For></Select>
      </div></Show>
      <section class="kt-reading" aria-label="设备阅读设置">
        <h3>设备阅读设置（只用于预览）</h3>
        <Show when={presets().length > 1} fallback={<p class="muted" data-reading-margin>页边距：{presets()[0]!.label}（{geometry().measured ? "实测" : "估算"}）</p>}>
          <Select label="设备页边距" value={reading().margin} disabled={busy()} onChange={event => editReading({ margin: event.currentTarget.value })}>
            <For each={presets()}>{preset => <option value={preset.id}>{preset.label}</option>}</For>
          </Select>
        </Show>
        <div class="kt-range"><label for="kt-reading-scale">字号</label>
          <input id="kt-reading-scale" aria-label="字号（%）" type="range" min={READING_SCALE_RANGE.min * 100} max={READING_SCALE_RANGE.max * 100} step={READING_SCALE_RANGE.step * 100} value={reading().scale * 100} disabled={busy()} onInput={event => editReading({ scale: Number(event.currentTarget.value) / 100 })} />
          <span class="kt-range-value"><output for="kt-reading-scale">{Math.round(reading().scale * 100)}%</output></span></div>
        <div class="kt-range"><label for="kt-reading-line-height">行距</label>
          <input id="kt-reading-line-height" aria-label="行距" type="range" min={READING_LINE_HEIGHT_RANGE.min} max={READING_LINE_HEIGHT_RANGE.max} step={READING_LINE_HEIGHT_RANGE.step} value={reading().lineHeight} disabled={busy()} onInput={event => editReading({ lineHeight: Number(event.currentTarget.value) })} />
          <span class="kt-range-value"><output for="kt-reading-line-height">{reading().lineHeight.toFixed(2)} 倍</output></span></div>
        <Button variant="quiet" class="kindle-text-button" disabled={busy() || JSON.stringify(reading()) === JSON.stringify(defaultReadingSettings(kind()))} onClick={resetReading}>恢复实测设置</Button>
      </section>
      <div class="kt-profile-controls"><Select label="方案" value={draft().id} disabled={busy() || loading()} onChange={event => {
        const selected = profiles().find(profile => profile.id === event.currentTarget.value);
        if (selected && (!dirty() || window.confirm("当前排版有未保存的修改，确定放弃吗？"))) selectProfile(selected);
        event.currentTarget.value = draft().id;
      }}>
        <Show when={!profiles().some(profile => profile.id === draft().id)}><option value={draft().id}>{draft().name}</option></Show>
        <For each={profiles()}>{profile => <option value={profile.id}>{profile.builtIn ? "默认 · 书籍自带样式" : profile.name}</option>}</For>
      </Select></div>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
      <Show when={settingsError() && !cssError()}><p role="alert" class="field-error">{settingsError()}</p></Show>
      <Show when={notice()}><p role="status">{notice()}</p></Show>
      <Show when={loading()}><p role="status">正在读取方案…</p></Show>
      <Show when={dirty()}><p role="status">有未保存的修改</p></Show>
      <Show when={draft().settings.fontFamily && !family()}><p class="muted">所选字体当前预览设备不可用，预览暂用替代字体；发送前请确认目标设备已安装。</p></Show>
      <Show when={!draft().builtIn} fallback={<p class="muted">默认方案只使用书籍自带样式，不做任何调整。要调整边距、行高等，请新建方案。</p>}>
      <For each={ranges}>{range => <div class="kt-range"><label for={`kt-${range.key}`}>{range.label}</label>
        <input id={`kt-${range.key}`} aria-label={`${range.label}${range.unit ? `（${range.unit}）` : ""}`} type="range" min={range.key === "marginX" ? marginMin() : range.min} max={range.key === "marginX" ? marginMax() : range.max} step={range.step} value={rangeValue(range.key) ?? range.fallback} disabled={immutable()} onInput={event => { const value = Number(event.currentTarget.value); if (range.key === "marginX") editMargin(value); else edit(range.key, value); }} />
        <span class="kt-range-value"><output for={`kt-${range.key}`} class={draft().settings[range.key] === null ? "is-inherited" : undefined} title={range.key === "marginX" && draft().settings.marginX !== null && draft().settings.marginXUnit === "em" ? "旧方案单位，随字号缩放；拖动后改用 %" : undefined}>{range.key === "marginX" ? marginText() : draft().settings[range.key] === null ? "书籍" : `${draft().settings[range.key]}${range.unit}`}</output>
        <button class="quiet kt-range-reset" type="button" aria-label={range.key === "marginX" ? "恢复默认" : "恢复沿用书籍"} title={range.key === "marginX" ? "恢复默认" : "恢复沿用书籍"} hidden={draft().settings[range.key] === null} disabled={immutable() || draft().settings[range.key] === null} onClick={() => { if (range.key === "marginX") editMargin(null); else edit(range.key, null); }}>↺</button></span>
      </div>}</For>
      <Select label="字体（预览设备上已安装）" value={draft().settings.fontFamily ?? ""} disabled={immutable()} onChange={event => edit("fontFamily", event.currentTarget.value || null)}>
        <option value="">设备默认字体</option>
        <Show when={draft().settings.fontFamily && !family()}><option value={draft().settings.fontFamily!}>{draft().settings.fontFamily}（尚未在当前设备读取到）</option></Show>
        <For each={fonts()}>{font => <option value={font.name}>{font.name}</option>}</For>
      </Select>
      <div class="kt-checkboxes" role="group" aria-label="正文样式">
        <Checkbox label="两端对齐" checked={draft().settings.justify === true} disabled={immutable()} onChange={event => edit("justify", event.currentTarget.checked)} />
        <Checkbox label="去掉书籍自带字体" checked={draft().settings.stripFonts} disabled={immutable()} onChange={event => edit("stripFonts", event.currentTarget.checked)} />
        <Checkbox label="去掉所有图片" checked={draft().settings.stripImages} disabled={immutable()} onChange={event => edit("stripImages", event.currentTarget.checked)} />
        <Checkbox label="去掉书籍自带页边距" checked={draft().settings.stripPageMargins} disabled={immutable()} onChange={event => edit("stripPageMargins", event.currentTarget.checked)} />
      </div>
      <details class="kt-advanced"><summary>更多设置</summary><div>
        <TextField label="方案名称" value={draft().name} disabled={immutable()} maxlength={100} onInput={event => setDraft(old => ({ ...old, name: event.currentTarget.value }))} />
        <Button variant="quiet" disabled={immutable() || draft().settings.justify === null} onClick={() => edit("justify", null)}>{draft().settings.justify === null ? "对齐方式沿用书籍" : "对齐方式恢复书籍设置"}</Button>
        <Textarea label="额外自定义 CSS" rows={6} value={draft().settings.customCss} disabled={immutable()} error={cssError() ?? undefined} onInput={event => edit("customCss", event.currentTarget.value)} />
        <Textarea label="生成的 CSS（只读）" rows={8} class="kt-generated" readonly value={css() ?? "排版参数校验未通过，预览保留上次有效样式。"} />
      </div></details>
      </Show>
      <Show when={!draft().builtIn} fallback={<div class="kt-actions kt-profile-actions"><Button disabled={!canStore()} onClick={openSaveAs}>新建方案</Button></div>}>
        <div class="kt-actions kt-profile-actions"><Button variant="quiet" disabled={busy() || loading() || !dirty()} onClick={reset}>重置</Button>
          <Button variant="quiet" disabled={immutable() || draft().id === "draft"} onClick={() => setDeleting(true)}>删除</Button>
          <Button variant="secondary" disabled={!canStore()} onClick={openSaveAs}>另存为</Button>
          <Button disabled={!canStore() || !dirty()} onClick={() => save()}>保存方案</Button></div>
      </Show>
      <SendToDevice bookId={bookId()} profileId={draft().id} options={{ settings: settingsError() ? EMPTY_SETTINGS : settings() }} blocked={sendBlocked()} />
    </section><section class="kt-preview kt-preview-sticky" aria-label="设备预览">
      <div class="kt-preview-header">
      <div class="kt-preview-toolbar"><div class="kt-preview-selectors"><PreviewBookPicker books={props.data.books} value={bookId()} disabled={!props.data.books.length} onChange={id => { void chooseBook(id); }} />
        <Select label="章节" value={String(chapter())} disabled={chapterLoading() || !sections().length} onChange={event => openChapter(Number(event.currentTarget.value))}><For each={sections()}>{(section, index) => <option value={String(index())}>{section.title}</option>}</For></Select>
      </div></div>
      <Show when={chapterLoading()}><p role="status">正在读取章节…</p></Show><Show when={chapterError()}><p role="alert" class="field-error">{chapterError()}</p></Show>
      <Show when={bookId() && chapterError()}><Button variant="secondary" disabled={chapterLoading()} onClick={() => chooseBook(bookId())}>重新读取章节</Button></Show>
      <Show when={!props.data.books.length}><p class="notice">书库中还没有可预览的 EPUB。</p></Show><Show when={bookId() && !sections().length && !chapterLoading() && !chapterError()}><p class="notice">这本书没有可预览的章节。</p></Show>
      </div>
      <ChapterFrame src={src()} geometry={geometry()} label={deviceKindLabel(kind())} css={css()} device={family() ? fontDevice() : null} family={family()} start={chapterStart()} hasPrevious={chapter() > 0} hasNext={chapter() + 1 < sections().length} onChapter={direction => openChapter(chapter() + direction, direction < 0 ? Number.MAX_SAFE_INTEGER : 1)} />
      <p class="muted" data-kindle-line-estimate data-typeset-estimate>{settingsError() ? "排版参数无效，预览保留上次有效样式。" : `预计每行约 ${estimate().charsPerLine} 字、每页 ${estimate().linesPerPage} 行（${estimate().measured ? "实测" : "估算"} · ${targetInfo().panel.width}×${targetInfo().panel.height}${targetInfo().fallbackPanel ? ` · 其他型号按 ${targetInfo().panel.width}×${targetInfo().panel.height} 预览` : ""}）`}</p>
      <Show when={overflow()}><p class="muted" data-overflow-note>左右边距超出设备自带边距，部分文字会被屏幕边缘切掉。</p></Show>
      <details class="kt-calibration"><summary>校准说明</summary>
        <p class="kt-spec">{deviceKindLabel(kind())} · {modelShortName(kind(), target()?.model ?? model())} · {targetInfo().panel.width}×{targetInfo().panel.height} · {targetInfo().panel.ppi} ppi</p>
        <p class="muted">设备阅读设置只影响预览，不会写入书籍；排版方案会写入 Kindle 和 Kobo 的传书副本。分页与真机会有少量差异，不模拟页眉页脚。</p>
        <p class="muted">实测：Kindle Paperwhite 3 窄边距、Kobo Libra 2 最小边距。其他型号与档位按屏幕像素密度估算。</p>
      </details>
    </section></div>
    <Dialog open={saveAs()} title={draft().builtIn ? "新建排版方案" : "另存为排版方案"} onClose={() => { if (!busy()) setSaveAs(false); }}><form onSubmit={event => { event.preventDefault(); void save(true); }}>
      <TextField label="新方案名称" value={saveName()} maxlength={100} required disabled={busy()} onInput={event => setSaveName(event.currentTarget.value)} /><p class="muted">排版方案由所有设备共用。默认方案始终保留。</p>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show><div class="kt-actions"><Button variant="secondary" disabled={busy()} onClick={() => setSaveAs(false)}>取消</Button><Button type="submit" disabled={!canStore() || !saveName().trim()}>保存新方案</Button></div>
    </form></Dialog>
    <ConfirmDialog open={deleting()} title="删除排版方案？" danger onClose={() => { if (!busy()) setDeleting(false); }} onConfirm={remove}><p>删除「{draft().name}」{dirty() ? "及其未保存的修改" : ""}？已经发送到设备的书籍不会改变。</p></ConfirmDialog>
  </section>;
}
