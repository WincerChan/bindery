import TablerCheck from "~icons/tabler/check";
import TablerChevronDown from "~icons/tabler/chevron-down";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { errorMessage } from "../../../client/devices/fs";
import { deviceKindLabel, kindleModelInfo, koboModelInfo, modelShortName, type DeviceKind } from "../../../client/devices/models";
import { defaultProfile, DEFAULT_PROFILE_ID, EMPTY_SETTINGS, generateProfileCss, profileSettings, type ProfileSettings, type TypesettingProfile } from "../../../client/devices/profiles";
import {
  convertMarginX, defaultReadingSettings, devicePresets, marginXPx, pageGeometry,
  previewEstimate, previewTarget, readingSettings, type DeviceReadingSettings,
} from "../../../client/devices/typeset";
import type { PairedDevice } from "../../../client/devices/identity";
import type { FontFamily } from "../../../client/devices/fonts";
import { validateCss } from "../../../core/css";
import { BackLink, Button, CenterDialog, ConfirmDialog, Icon, PageIntro, SegmentedControl, Select, SelectPill, Slider, Stepper, Textarea, TextField, ToggleChip } from "../../../ui";
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
const previewModels = (["kindle", "kobo"] as const).flatMap(kind => modelOptions(kind).map(([model, label]) => ({ value: `model:${kind}:${model}`, label, kind, model })));
/** Cover/title pages are not typesetting samples; open the first text chapter instead. */
const firstTextChapter = (sections: readonly PreviewChapter[]) => { const index = sections.findIndex(section => !/^(封面|cover|title ?page|制作说明|内容简介|简介|作者简介|书评|目录|版权|copyright|扉页|书名页|出版信息|序言|序|前言|后记|附录|插图|彩页)/i.test(section.title.trim())); return index < 0 ? 0 : index; };

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
  const [profiles, setProfiles] = createSignal<TypesettingProfile[]>([]), [profilesReady, setProfilesReady] = createSignal(false), [draft, setDraft] = createSignal<TypesettingProfile>(defaultProfile());
  const [baseline, setBaseline] = createSignal(JSON.stringify(defaultProfile())), [sent, setSent] = createSignal<string | null>(null);
  const [fonts, setFonts] = createSignal<FontFamily[]>([]);
  const [busy, setBusy] = createSignal(false), [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal(""), [switchNotice, setSwitchNotice] = createSignal<Target | null>(null);
  const [saveAs, setSaveAs] = createSignal(false), [saveName, setSaveName] = createSignal(""), [deleting, setDeleting] = createSignal(false);
  const [bookId, setBookId] = createSignal(props.data.bookId), [sections, setSections] = createSignal(props.data.sections), [chapter, setChapter] = createSignal(firstTextChapter(props.data.sections)), [chapterStart, setChapterStart] = createSignal({ page: 1 });
  const [chapterLoading, setChapterLoading] = createSignal(false), [chapterError, setChapterError] = createSignal(props.data.error);
  let disposed = false, profileRequest = 0, chapterRequest = 0, initialFontApplied = false, readingRequest = 0, saveTimer: ReturnType<typeof setTimeout> | undefined, followedId: string | undefined, modelOnlyByUser = false, lastGrant: { id: string; root: unknown } | null = null;

  const previewName = () => target()?.name ?? modelShortName(modelKind(), model());
  const kind = () => target()?.kind ?? modelKind();
  const targetInfo = createMemo(() => previewTarget(kind(), target()?.model ?? model()));
  const geometry = createMemo(() => pageGeometry(targetInfo(), reading()));
  const presets = createMemo(() => devicePresets(kind(), targetInfo().panel));
  const connectedId = createMemo(() => connected()?.identity.id);
  const readingKey = createMemo(() => target()?.id ? `${target()!.id}:${kind()}` : `model:${kind()}`);
  const fontDevice = createMemo<PairedDevice | null>(() => { const current = connected(), selected = target(); return current && selected?.id === current.identity.id ? current : null; });
  const family = createMemo(() => fonts().find(value => value.name === draft().settings.fontFamily));
  const dirty = () => JSON.stringify(draft()) !== baseline();
  const blockerDirty = () => dirty() && sent() !== JSON.stringify(draft());
  const settings = () => profileSettings(draft().settings);
  const settingsError = () => { try { settings(); return ""; } catch (error) { return errorMessage(error); } };
  const cssError = () => validateCss(draft().settings.customCss);
  const css = () => settingsError() ? null : generateProfileCss({ ...draft(), settings: settings() });
  const locked = () => busy() || loading();
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
  const previewOptions = () => [
    ...available().map(identity => ({ value: identity.id, label: `${modelShortName(identity.kind, identity.model)} · ${identity.name}` })),
    ...previewModels,
  ];
  function openChapter(index: number, page = 1) { setChapter(index); setChapterStart({ page }); }
  function selectProfile(profile: TypesettingProfile) { const selected = copyProfile(profile); setDraft(selected); setBaseline(JSON.stringify(selected)); setSent(null); setError(""); setNotice(""); }
  function resolveProfileId(id: string) { return id === DEFAULT_PROFILE_ID || profiles().some(profile => profile.id === id) ? id : DEFAULT_PROFILE_ID; }
  function applyRememberedProfile(value: DeviceReadingSettings) {
    if (!profilesReady() || blockerDirty() || !target()?.id) return;
    const profileId = resolveProfileId(value.profileId);
    if (profileId !== value.profileId) setReading(current => ({ ...current, profileId }));
    if (profileId === draft().id) return;
    selectProfile(profiles().find(profile => profile.id === profileId) ?? defaultProfile());
  }
  function rememberProfile(profileId: string) {
    const selected = target();
    if (!selected?.id || !props.reading) return;
    const value = readingSettings(selected.kind, { ...reading(), profileId });
    setReading(value);
    scheduleReadingSave(value);
  }
  function edit<K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) { if (!locked()) setDraft(old => ({ ...old, settings: { ...old.settings, [key]: value } })); }
  function editMargin(value: number | null) { if (!locked()) setDraft(old => ({ ...old, settings: { ...old.settings, marginX: value, ...(value === null ? {} : { marginXUnit: "percent" as const }) } })); }
  function editReading(patch: Partial<DeviceReadingSettings>) { const value = readingSettings(kind(), { ...reading(), ...patch }); setReading(value); scheduleReadingSave(value); }
  function scheduleReadingSave(value: DeviceReadingSettings) {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    const selected = target(), api = props.reading;
    if (!selected?.id || !api) return;
    saveTimer = setTimeout(() => { saveTimer = undefined; if (!disposed) void api.save(selected.id, selected.kind, value).catch(error => { if (!disposed) setError(errorMessage(error)); }); }, 500);
  }
  function choosePreview(value: string) {
    if (busy()) return;
    const identity = available().find(identity => identity.id === value), selectedModel = previewModels.find(model => model.value === value);
    if (!identity && !selectedModel) return;
    modelOnlyByUser = !identity; followedId = undefined; setSwitchNotice(null);
    if (selectedModel) { setModelKind(selectedModel.kind); setModel(selectedModel.model); }
    setTarget(identity ? { id: identity.id, kind: identity.kind, model: identity.model, name: identity.name } : null);
  }
  function switchToPendingGrant() {
    const pending = switchNotice();
    if (!pending) return;
    setSwitchNotice(null); followedId = pending.id; modelOnlyByUser = false; setTarget(pending);
  }
  function openSaveAs() { setSaveName(draft().builtIn && draft().name === defaultProfile().name ? "我的排版" : draft().name); setSaveAs(true); }
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
      setProfiles(items => items.filter(item => item.id !== current.id));
      if (reading().profileId === current.id) setReading(value => ({ ...value, profileId: DEFAULT_PROFILE_ID }));
      selectProfile(defaultProfile()); setNotice("排版方案已删除。");
    } catch (error) { if (!disposed) setError(errorMessage(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function loadProfiles() {
    const request = ++profileRequest; setLoading(true); setError(""); setProfilesReady(false);
    try {
      const items = await props.profiles.list();
      if (disposed || request !== profileRequest) return;
      setProfiles(items); setProfilesReady(true); selectProfile(items.find(item => item.builtIn) ?? defaultProfile());
      if (props.initialFont && !initialFontApplied) { initialFontApplied = true; setDraft({ id: "draft", name: "字体预览", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: props.initialFont } }); }
      applyRememberedProfile(reading());
    } catch (error) { if (!disposed && request === profileRequest) { setProfilesReady(false); selectProfile(defaultProfile()); setError(errorMessage(error)); } }
    finally { if (!disposed && request === profileRequest) setLoading(false); }
  }
  async function chooseBook(id: string) {
    const request = ++chapterRequest; setBookId(id); setSections([]); openChapter(0); setChapterLoading(true); setChapterError("");
    try { const result = await props.chapters(id); if (!disposed && request === chapterRequest) { setSections(result); openChapter(firstTextChapter(result)); } }
    catch (error) { if (!disposed && request === chapterRequest) setChapterError(errorMessage(error)); }
    finally { if (!disposed && request === chapterRequest) setChapterLoading(false); }
  }
  createEffect(() => props.data, data => { chapterRequest++; setBookId(data.bookId); setSections(data.sections); openChapter(firstTextChapter(data.sections)); setChapterLoading(false); setChapterError(data.error); });
  createEffect(state, () => {
    // `restore()` briefly keeps the previous status; checkedAt confirms a completed probe.
    const current = state(), grant = current?.status === "granted" && current.checkedAt !== null ? current.device : null;
    if (!grant) { lastGrant = null; return; }
    if (lastGrant?.id === grant.identity.id && lastGrant.root === grant.root) return;
    lastGrant = { id: grant.identity.id, root: grant.root };
    const identity = { id: grant.identity.id, kind: grant.identity.kind, model: grant.identity.model, name: grant.identity.name };
    // A new connection or reconnect always becomes the preview target, unless an unsaved, unsent draft would be lost.
    if (untrack(blockerDirty)) {
      if (untrack(target)?.id !== identity.id) setSwitchNotice(identity);
      return;
    }
    followedId = identity.id; modelOnlyByUser = false; setSwitchNotice(null); setTarget(identity);
  });
  createEffect(currentIdentity, identity => {
    // A restored but not granted device keeps the old rule: only the default target follows it.
    if (!identity || state()?.status === "granted" || modelOnlyByUser || (target() && target()!.id !== followedId)) return;
    followedId = identity.id; setTarget({ id: identity.id, kind: identity.kind, model: identity.model, name: identity.name });
  });
  createEffect(readingKey, () => {
    const selected = target(), request = ++readingRequest;
    if (!selected?.id || !props.reading) { const value = defaultReadingSettings(kind()); setReading(value); applyRememberedProfile(value); return; }
    void props.reading.get(selected.id, selected.kind).then(value => {
      if (disposed || request !== readingRequest) return;
      const normalized = readingSettings(selected.kind, value); setReading(normalized); applyRememberedProfile(normalized);
    }, error => { if (!disposed && request === readingRequest) { setReading(defaultReadingSettings(selected.kind)); setError(errorMessage(error)); } });
  });
  createEffect(() => fontDevice()?.identity.id, () => {
    const current = fontDevice();
    setFonts(current ? device?.inventory()?.fonts ?? [] : []);
  });
  createEffect(blockerDirty, value => { props.onDirty?.(value); });
  onSettled(() => { void loadProfiles(); });
  onCleanup(() => { disposed = true; profileRequest++; chapterRequest++; readingRequest++; if (saveTimer !== undefined) clearTimeout(saveTimer); });
  const src = () => { const section = sections()[chapter()]; return section ? previewContentUrl(bookId(), section.item_path, settingsError() ? EMPTY_SETTINGS : draft().settings) : ""; };
  return <section class="kt-page device-preview-page" aria-label="排版与预览">
    <PageIntro class="kt-topbar" variant="topbar" back={<BackLink href={bookId() ? `/book/${encodeURIComponent(bookId())}` : "/devices"}>{bookId() ? "返回书籍" : "设备"}</BackLink>} title="排版预览"
      actions={<>
        <PreviewBookPicker pill books={props.data.books} value={bookId()} disabled={!props.data.books.length} onChange={id => { void chooseBook(id); }} />
        <SelectPill label="章节" value={String(chapter())} disabled={chapterLoading() || !sections().length} options={sections().map((section, index) => ({ value: String(index), label: section.title }))} onChange={value => openChapter(Number(value))} />
        <span class="kt-topbar-spacer" />
        <SelectPill class="kt-device-pill" label="预览型号" value={target()?.id ?? `model:${modelKind()}:${model()}`} disabled={busy()} options={previewOptions()} onChange={choosePreview} />
        <h2 class="sr-only">设备阅读设置（只用于预览）</h2>
        <SelectPill label="设备边距" value={reading().margin} disabled={busy()} options={presets().map(preset => ({ value: preset.id, label: preset.label }))} onChange={margin => editReading({ margin })} />
      </>} />
    <Show when={chapterLoading()}><p role="status" class="kt-chapter-status">正在读取章节…</p></Show>
    <Show when={chapterError()}><p role="alert" class="field-error">{chapterError()}</p></Show>
    <Show when={bookId() && chapterError()}><Button variant="secondary" disabled={chapterLoading()} onClick={() => chooseBook(bookId())}>重新读取章节</Button></Show>
    <Show when={!props.data.books.length}><p class="notice">书库中还没有可预览的 EPUB。</p></Show>
    <Show when={bookId() && !sections().length && !chapterLoading() && !chapterError()}><p class="notice">这本书没有可预览的章节。</p></Show>
    <div class="kt-preview-layout"><section class="kt-preview kt-preview-sticky" aria-label="设备预览">
      <ChapterFrame src={src()} geometry={geometry()} kind={kind()} model={target()?.model ?? model()} label={deviceKindLabel(kind())} css={css()} device={family() ? fontDevice() : null} family={family()} start={chapterStart()} hasPrevious={chapter() > 0} hasNext={chapter() + 1 < sections().length} onChapter={direction => openChapter(chapter() + direction, direction < 0 ? Number.MAX_SAFE_INTEGER : 1)} />
      <p class="kt-preview-caption">只模拟正文分页，不含页眉页脚，和真机会有少量差异。</p>
      <Show when={overflow()}><p class="kt-warning-note" role="alert" data-overflow-note>⚠ 左右边距超出设备自带边距，部分文字会被屏幕边缘切掉。</p></Show>
      <details class="kt-calibration"><summary>校准说明</summary>
        <p class="muted" data-kindle-line-estimate>{settingsError() ? "排版参数无效，预览保留上次有效样式。" : `预计每行约 ${estimate().charsPerLine} 字、每页 ${estimate().linesPerPage} 行（${estimate().measured ? "实测" : "估算"} · ${targetInfo().panel.width}×${targetInfo().panel.height}${targetInfo().fallbackPanel ? ` · 其他型号按 ${targetInfo().panel.width}×${targetInfo().panel.height} 预览` : ""}）`}</p>
        <p class="kt-spec">{modelShortName(kind(), target()?.model ?? model())} · {targetInfo().panel.width}×{targetInfo().panel.height} · {targetInfo().panel.ppi} ppi</p>
        <p class="muted">设备阅读设置只影响预览，不会写入书籍；排版方案会写入 Kindle 和 Kobo 的传书副本。分页与真机会有少量差异，不模拟页眉页脚。</p>
        <p class="muted">实测：Kindle Paperwhite 3 窄边距、Kobo Libra 2 最小边距。其他型号与档位按屏幕像素密度估算。</p>
      </details>
    </section><section class="kt-editor" aria-label="排版方案编辑器">
      <div class="kt-profile-block">
        <p class="kt-profile-label">排版方案</p>
        <div class="kt-profile-row"><div class="kt-profile-controls"><Select class="kt-profile-select" label="方案" value={draft().id} disabled={busy() || loading()} onChange={event => {
          const selected = profiles().find(profile => profile.id === event.currentTarget.value);
          if (selected && (!dirty() || window.confirm("当前排版有未保存的修改，确定放弃吗？"))) { selectProfile(selected); rememberProfile(selected.id); }
          event.currentTarget.value = draft().id;
        }}>
          <Show when={!profiles().some(profile => profile.id === draft().id)}><option value={draft().id}>{draft().name}{dirty() ? " · 已调整（未保存）" : ""}</option></Show>
          <For each={profiles()}>{profile => <option value={profile.id}>{(profile.builtIn ? defaultProfile().name : profile.name) + (profile.id === draft().id && dirty() ? " · 已调整（未保存）" : "")}</option>}</For>
        </Select><Icon icon={TablerChevronDown} size={16} class="kt-profile-chevron" /></div>
        <Show when={dirty()}><p role="status" class="kt-dirty-note"><span aria-hidden="true" />有修改<span class="sr-only">有未保存的修改</span></p></Show></div>
        <p class="kt-profile-description">所有设备共用；发送时写进设备上的副本，书库里的书不变。调整后可直接发送，不必保存为方案。</p>
      </div>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show>
      <Show when={settingsError() && !cssError()}><p role="alert" class="field-error">{settingsError()}</p></Show>
      <Show when={notice()}><p role="status" class="kt-success-note"><Icon icon={TablerCheck} size={16} /> {notice()}</p></Show>
      <Show when={switchNotice()}>{pending => <p role="status" class="notice">已连接「{pending().name}」，当前排版有未保存的修改。<Button variant="quiet" disabled={busy()} onClick={switchToPendingGrant}>切换到 {pending().name}</Button></p>}</Show>
      <Show when={loading()}><p role="status">正在读取方案…</p></Show>
      <Show when={draft().settings.fontFamily && !family()}><p class="muted">所选字体当前预览设备不可用，预览暂用替代字体；发送前请确认目标设备已安装。</p></Show>
      <Select class="kt-pill-select" label="字体（预览设备上已安装）" value={draft().settings.fontFamily ?? ""} disabled={locked()} onChange={event => edit("fontFamily", event.currentTarget.value || null)}>
        <option value="">设备默认字体</option>
        <Show when={draft().settings.fontFamily && !family()}><option value={draft().settings.fontFamily!}>{draft().settings.fontFamily}（尚未在当前设备读取到）</option></Show>
        <For each={fonts()}>{font => <option value={font.name}>{font.name}</option>}</For>
      </Select>
      <For each={ranges}>{range => <div class="kt-range">
        <div class="kt-range-head"><span class="kt-stepper-label">{range.label}</span><span class="kt-range-value"><output aria-label={`${range.label}当前值`} class={draft().settings[range.key] === null ? "is-inherited" : undefined} title={range.key === "marginX" && draft().settings.marginX !== null && draft().settings.marginXUnit === "em" ? "旧方案单位，随字号缩放；拖动后改用 %" : undefined}>{range.key === "marginX" ? marginText() : draft().settings[range.key] === null ? "书籍" : `${draft().settings[range.key]}${range.unit}`}</output><button class="quiet kt-range-reset" type="button" aria-label={range.key === "marginX" ? "恢复默认" : "恢复沿用书籍"} title={range.key === "marginX" ? "恢复默认" : "恢复沿用书籍"} hidden={draft().settings[range.key] === null} disabled={locked() || draft().settings[range.key] === null} onClick={() => { if (range.key === "marginX") editMargin(null); else edit(range.key, null); }}>↺</button></span></div>
        <Show when={range.key === "paragraphSpacing" || range.key === "textIndent"} fallback={<Slider label={`${range.label}${range.unit ? `（${range.unit}）` : ""}`} min={range.key === "marginX" ? marginMin() : range.min} max={range.key === "marginX" ? marginMax() : range.max} step={range.step} value={rangeValue(range.key) ?? range.fallback} disabled={locked()} formatValue={value => range.key === "marginX" ? marginText() : draft().settings[range.key] === null ? "书籍" : `${value}${range.unit}`} onChange={value => { if (range.key === "marginX") editMargin(value); else edit(range.key, value); }} />}>
          <Stepper label={`${range.label}（${range.unit}）`} min={range.min} max={range.max} step={range.step} value={rangeValue(range.key) ?? range.fallback} disabled={locked()} onChange={value => edit(range.key, Number(value.toFixed(2)))} />
        </Show>
      </div>}</For>
      <fieldset class="kt-checkboxes"><legend>去掉书里自带的</legend><div class="kt-actions">
        <For each={[["stripFonts", "字体"], ["stripImages", "图片"], ["stripPageMargins", "页边距"], ["stripLineHeight", "行高"], ["stripParagraphSpacing", "段间距"]] as const}>{([key, label]) => <ToggleChip aria-label={key === "stripImages" ? "去掉所有图片" : `去掉书籍自带${label}`} selected={draft().settings[key]} disabled={locked()} onClick={() => edit(key, !draft().settings[key])}>{label}</ToggleChip>}</For>
      </div></fieldset>
      <details class="kt-advanced"><summary>自定义 CSS</summary><div>
        <Show when={!draft().builtIn && draft().id !== "draft"}><TextField label="方案名称" value={draft().name} disabled={locked()} maxlength={100} onInput={event => setDraft(old => ({ ...old, name: event.currentTarget.value }))} /></Show>
        <Textarea label="额外自定义 CSS" rows={6} value={draft().settings.customCss} disabled={locked()} error={cssError() ?? undefined} onInput={event => edit("customCss", event.currentTarget.value)} />
        <Textarea label="生成的 CSS（只读）" rows={8} class="kt-generated" readonly value={css() ?? "排版参数校验未通过，预览保留上次有效样式。"} />
      </div></details>
      <div class="kt-actions kt-profile-actions"><Button variant="quiet" aria-label="重置" disabled={locked() || !dirty()} onClick={reset}>还原</Button>
        <Show when={!draft().builtIn && draft().id !== "draft"}><Button variant="quiet" aria-label="删除" disabled={locked()} onClick={() => setDeleting(true)}>删除</Button></Show>
        <Button variant="secondary" aria-label="另存为方案" disabled={!canStore()} onClick={openSaveAs}>另存为</Button>
        <Show when={!draft().builtIn && draft().id !== "draft"}><Button aria-label="保存方案" disabled={!canStore()} onClick={() => save()}>保存</Button></Show></div>
      <SendToDevice bookId={bookId()} bookTitle={props.data.books.find(book => book.id === bookId())?.title} profileId={draft().id} options={{ settings: settingsError() ? EMPTY_SETTINGS : settings(), ...(draft().id === DEFAULT_PROFILE_ID ? {} : { profileName: draft().name }) }} onSent={() => setSent(JSON.stringify(draft()))} blocked={sendBlocked()} />
    </section></div>
    <CenterDialog open={saveAs()} title={draft().builtIn ? "新建排版方案" : "另存为排版方案"} onClose={() => { if (!busy()) setSaveAs(false); }}><form class="form-stack" onSubmit={event => { event.preventDefault(); void save(true); }}>
      <TextField label="新方案名称" value={saveName()} maxlength={100} required disabled={busy()} onInput={event => setSaveName(event.currentTarget.value)} /><p class="muted">排版方案由所有设备共用。默认方案始终保留。</p>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show><div class="form-actions"><Button variant="quiet" disabled={busy()} onClick={() => setSaveAs(false)}>取消</Button><Button type="submit" disabled={!canStore() || !saveName().trim()}>保存新方案</Button></div>
    </form></CenterDialog>
    <ConfirmDialog open={deleting()} title="删除排版方案？" danger onClose={() => { if (!busy()) setDeleting(false); }} onConfirm={remove}><p>删除「{draft().name}」{dirty() ? "及其未保存的修改" : ""}？已经发送到设备的书籍不会改变。</p></ConfirmDialog>
  </section>;

}
