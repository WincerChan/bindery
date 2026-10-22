import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { defaultProfile, EMPTY_SETTINGS, generateProfileCss, profileSettings, type ProfileSettings, type TypesettingProfile } from "../../../client/kindle/profiles";
import { deviceInventory } from "../../../client/kindle/inventory";
import { errorMessage } from "../../../client/kindle/fs";
import { KINDLE_MODELS, type KindleModel } from "../../../client/kindle/identity";
import { convertMarginX, KINDLE_MARGIN_PRESETS, kindlePreviewMetrics, minimumMarginX, type KindleMarginPreset } from "../../../client/kindle/margins";
import type { FontFamily, KindleDeviceManager } from "../../../client/kindle";
import { validateCss } from "../../../core/css";
import { Button, Checkbox, ConfirmDialog, Dialog, Select, Textarea, TextField } from "../../../ui";
import { usePageDevice } from "./device";
import { ChapterFrame } from "./frames";
import { PreviewBookPicker } from "./book-picker";
import { Link } from "../../../shared/spa-link";
import { previewContentUrl, screenFor, type PreviewChapter, type PreviewData } from "./model";

export interface ProfileApi {
  list(deviceId: string): Promise<TypesettingProfile[]>;
  create(profile: { deviceId: string; name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  update(profile: { deviceId: string; id: string; name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  delete(deviceId: string, id: string): Promise<unknown>;
}
const ranges = [
  { key: "marginX", label: "左右边距调整", unit: "%", min: -10, max: 20, fallback: 0, step: 0.1 },
  { key: "lineHeight", label: "行高", unit: "", min: 1.2, max: 2.4, fallback: 1.6, step: 0.05 },
  { key: "paragraphSpacing", label: "段间距", unit: "em", min: 0, max: 1.5, fallback: 0, step: 0.1 },
  { key: "textIndent", label: "首行缩进", unit: "em", min: 0, max: 3, fallback: 2, step: 0.5 },
] as const;
type Target = { id: string; model: KindleModel; name: string };
const copy = (profile: TypesettingProfile): TypesettingProfile => ({ ...profile, settings: { ...profile.settings } });

export function TypesetPage(props: { manager: KindleDeviceManager | null; data: PreviewData; initialFont?: string; profiles: ProfileApi; chapters: (bookId: string) => Promise<PreviewChapter[]>; onDirty?: (dirty: boolean) => void }) {
  const { state, remembered, memoryError } = usePageDevice(props.manager);
  const [target, setTarget] = createSignal<Target | null>(null), [model, setModel] = createSignal<KindleModel>("KPW3");
  const [profiles, setProfiles] = createSignal<TypesettingProfile[]>([]);
  const [draft, setDraft] = createSignal<TypesettingProfile>(defaultProfile("")), [baseline, setBaseline] = createSignal(JSON.stringify(defaultProfile("")));
  const [fonts, setFonts] = createSignal<FontFamily[]>([]), [busy, setBusy] = createSignal(false), [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const [saveAs, setSaveAs] = createSignal(false), [saveName, setSaveName] = createSignal(""), [deleting, setDeleting] = createSignal(false);
  const [bookId, setBookId] = createSignal(props.data.bookId), [sections, setSections] = createSignal(props.data.sections), [chapter, setChapter] = createSignal(0);
  const [chapterStart, setChapterStart] = createSignal({ page: 1 });
  function openChapter(index: number, page = 1) { setChapter(index); setChapterStart({ page }); }
  const [chapterLoading, setChapterLoading] = createSignal(false), [chapterError, setChapterError] = createSignal(props.data.error);
  let disposed = false, profileRequest = 0, fontRequest = 0, chapterRequest = 0, initialFontApplied = false;
  // The built-in profile cannot be saved; its only edit is the preview-only Kindle margin preset.
  const dirty = () => !draft().builtIn && JSON.stringify(draft()) !== baseline();
  const cssError = () => validateCss(draft().settings.customCss);
  const currentSettings = () => ({ ...draft().settings, deviceModel: effectiveModel() });
  const settingsError = () => { try { profileSettings(currentSettings()); return ""; } catch (error) { return errorMessage(error); } };
  const css = () => settingsError() ? null : generateProfileCss({ ...draft(), settings: currentSettings() });
  const connected = () => state()?.status === "granted" ? state()!.device : null;
  const fontDevice = () => connected()?.identity.id === target()?.id ? connected() : null;
  const effectiveModel = () => target()?.model ?? model();
  const metrics = () => kindlePreviewMetrics(effectiveModel(), draft().settings.kindleMargin, draft().settings.marginX, draft().settings.marginXUnit);
  // Keep the slider on its 0.1% grid without offering a value that would cross the screen edge.
  const marginMin = () => Math.ceil(minimumMarginX(effectiveModel(), draft().settings.kindleMargin, "percent") * 10) / 10;
  // Legacy em values keep their unit until edited; the slider shows their size-7 equivalent.
  const marginPercent = () => {
    const { marginX, marginXUnit, kindleMargin } = draft().settings;
    return marginX === null ? null : Math.round(convertMarginX(effectiveModel(), kindleMargin, marginX, marginXUnit, "percent") * 10) / 10;
  };
  const marginText = () => {
    const { marginX, marginXUnit } = draft().settings;
    return marginX === null ? "默认" : `${marginX}${marginXUnit === "em" ? "em" : "%"}`;
  };
  const rangeValue = (key: (typeof ranges)[number]["key"]) => key === "marginX" ? marginPercent() : draft().settings[key];
  const immutable = () => draft().builtIn || busy() || loading();
  const canStore = () => Boolean(target()) && !busy() && !loading() && !settingsError();
  const confirmDiscard = () => !dirty() || window.confirm("当前排版有未保存的修改，确定放弃吗？");
  createEffect(() => props.data, data => {
    chapterRequest++; setBookId(data.bookId); setSections(data.sections); openChapter(0); setChapterLoading(false); setChapterError(data.error);
  });
  function selectProfile(profile: TypesettingProfile) {
    const selected = copy(profile);
    selected.settings = { ...selected.settings, deviceModel: effectiveModel() };
    setDraft(selected); setBaseline(JSON.stringify(selected)); setError(""); setNotice("");
  }
  function edit<K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) {
    if (immutable()) return;
    setDraft(old => ({ ...old, settings: { ...old.settings, [key]: value } }));
  }
  function editMargin(value: number | null) {
    if (immutable()) return;
    setDraft(old => ({ ...old, settings: { ...old.settings, marginX: value, ...(value === null ? {} : { marginXUnit: "percent" as const }) } }));
  }
  // Callbacks such as a signal setter may return a value; only functions are effect cleanups.
  createEffect(dirty, value => { props.onDirty?.(value); });
  onCleanup(() => { disposed = true; profileRequest++; fontRequest++; chapterRequest++; });
  // An external device switch must not silently discard a draft or retarget its save operation.
  const deviceId = createMemo(() => state()?.device?.identity.id);
  createEffect(deviceId, () => {
    const identity = state()?.device?.identity;
    if (identity && identity.kind === "kindle" && !dirty() && !busy()) setTarget({ id: identity.id, model: identity.model as KindleModel, name: identity.name });
  });
  const targetId = createMemo(() => target()?.id ?? "");
  createEffect(targetId, id => { void loadProfiles(id); });
  async function loadProfiles(id: string) {
    const request = ++profileRequest;
    setProfiles([]); setError(""); setLoading(Boolean(id));
    if (!id) { selectProfile(defaultProfile("")); return; }
    try {
      const items = await props.profiles.list(id);
      if (disposed || request !== profileRequest) return;
      setProfiles(items); selectProfile(items.find(item => item.builtIn) ?? defaultProfile(id));
      if (props.initialFont && !initialFontApplied) {
        initialFontApplied = true;
        setDraft({ id: "draft", deviceId: id, name: "字体预览", builtIn: false, settings: { ...EMPTY_SETTINGS, fontFamily: props.initialFont } });
      }
    } catch (error) { if (!disposed && request === profileRequest) { selectProfile(defaultProfile(id)); setError(errorMessage(error)); } }
    finally { if (!disposed && request === profileRequest) setLoading(false); }
  }
  const fontSource = createMemo(() => `${state()?.status}:${deviceId() ?? ""}:${targetId()}`);
  createEffect(fontSource, () => { void scanFonts(); });
  async function scanFonts() {
    const request = ++fontRequest, device = fontDevice(); setFonts([]);
    if (!device) return;
    try { const result = await deviceInventory(device); if (!disposed && request === fontRequest) setFonts(result.fonts); }
    catch (error) { if (!disposed && request === fontRequest) setError(errorMessage(error)); }
  }
  function chooseTarget(id: string) {
    if (busy() || !confirmDiscard()) return;
    const known = remembered().find(device => device.id === id), current = state()?.device?.identity;
    const identity = known?.identity ?? (current?.id === id ? current : null);
    setTarget(identity && identity.kind === "kindle" ? { id: identity.id, model: identity.model as KindleModel, name: identity.name } : null);
  }
  function reset() { if (confirmDiscard()) selectProfile(JSON.parse(baseline()) as TypesettingProfile); }
  function openSaveAs() { setSaveName(draft().builtIn ? "我的排版" : draft().name); setSaveAs(true); }
  async function save(asNew = false) {
    const selected = target(); if (!selected || !canStore()) return;
    if (!asNew && (draft().builtIn || draft().id === "draft")) { openSaveAs(); return; }
    setBusy(true); setError("");
    try {
      const current = draft(), settings = profileSettings(currentSettings());
      const input = { deviceId: selected.id, name: asNew ? saveName() : current.name, settings };
      const saved = asNew ? await props.profiles.create(input) : await props.profiles.update({ ...input, id: current.id });
      if (disposed || target()?.id !== selected.id) return;
      setProfiles(items => [...items.filter(item => item.id !== saved.id), saved]); selectProfile(saved); setSaveAs(false); setNotice("排版方案已保存。传书时选择此方案即可应用。");
    } catch (error) { if (!disposed) setError(errorMessage(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function remove() {
    const current = draft(); if (current.builtIn || current.id === "draft" || !target() || busy()) return;
    setBusy(true);
    try {
      await props.profiles.delete(current.deviceId, current.id);
      if (disposed) return;
      setProfiles(items => items.filter(item => item.id !== current.id)); selectProfile(defaultProfile(current.deviceId)); setNotice("排版方案已删除。");
    } finally { if (!disposed) setBusy(false); }
  }
  async function chooseBook(id: string) {
    const request = ++chapterRequest; setBookId(id); setSections([]); openChapter(0); setChapterLoading(true); setChapterError("");
    try { const result = await props.chapters(id); if (!disposed && request === chapterRequest) setSections(result); }
    catch (error) { if (!disposed && request === chapterRequest) setChapterError(errorMessage(error)); }
    finally { if (!disposed && request === chapterRequest) setChapterLoading(false); }
  }
  const availableTargets = () => {
    const items = remembered().map(device => device.identity).filter(identity => identity.kind === "kindle");
    const identity = state()?.device?.identity;
    if (identity && identity.kind === "kindle" && !items.some(item => item.id === identity.id)) items.unshift(identity);
    const selected = target(); if (selected && !items.some(item => item.id === selected.id)) items.push({ id: selected.id, kind: "kindle", model: selected.model, name: selected.name, created_at: "" });
    return items;
  };
  return <section class="kt-page" aria-label="排版与预览">
    <div class="kt-preview-layout"><section class="kt-editor" aria-label="排版方案编辑器">
      <div class="kt-editor-heading"><h2>排版方案</h2><p class="muted">转换前追加到书籍 CSS 之后，只影响传到这台设备的副本，书库里的 EPUB 不变。</p></div>
      <Select label="方案所属设备" value={target()?.id ?? ""} disabled={busy()} onChange={event => { chooseTarget(event.currentTarget.value); event.currentTarget.value = target()?.id ?? ""; }}>
        <option value="">仅预览型号</option><For each={availableTargets()}>{device => <option value={device.id}>{device.name} · {device.model}</option>}</For>
      </Select>
      <div class="kt-profile-controls"><Select label="方案" value={draft().id} disabled={busy() || loading() || !target()} onChange={event => {
        const selected = profiles().find(profile => profile.id === event.currentTarget.value);
        if (selected && confirmDiscard()) selectProfile(selected);
        event.currentTarget.value = draft().id;
      }}>
        <Show when={!profiles().some(profile => profile.id === draft().id)}><option value={draft().id}>{draft().name}</option></Show>
        <For each={profiles()}>{profile => <option value={profile.id}>{profile.builtIn ? "默认 · 书籍自带样式" : profile.name}</option>}</For>
      </Select>
      <Show when={!target()}><div class="kt-models" role="group" aria-label="预览型号"><For each={["KO3", "KPW3", "other"] as const}>{value => <button type="button" aria-pressed={model() === value ? "true" : "false"} onClick={() => setModel(value)}>{value === "other" ? "其他" : value}</button>}</For></div></Show></div>
      <Show when={!state()}><p role="status">检测中…</p></Show>
      <Show when={!fontDevice()}><p class="muted">排版方案属于已配对的设备。可选择记住的设备离线编辑；连接并授权后才能加载设备字体。<Link href="/kindle/connect">连接设备</Link></p></Show>
      <Show when={connected() && target() && connected()!.identity.id !== target()!.id}><p class="notice">当前连接的设备与正在编辑的方案所属设备不同；保存仍属于 {target()!.name}。</p></Show>
      <Show when={error() || memoryError()}><p role="alert" class="field-error">{error() || memoryError()}</p></Show>
      <Show when={settingsError() && !cssError()}><p role="alert" class="field-error">{settingsError()}</p></Show>
      <Show when={notice()}><p role="status">{notice()}</p></Show>
      <Show when={loading()}><p role="status">正在读取方案…</p></Show>
      <Show when={dirty()}><p role="status">有未保存的修改</p></Show>
      <Show when={!draft().builtIn} fallback={<p class="muted">默认方案只使用书籍自带样式，不做任何调整。要调整边距、行高等，请新建方案。</p>}>
      <For each={ranges}>{range => <div class="kt-range"><label for={`kt-${range.key}`}>{range.label}</label>
        <input id={`kt-${range.key}`} aria-label={`${range.label}${range.unit ? `（${range.unit}）` : ""}`} type="range" min={range.key === "marginX" ? marginMin() : range.min} max={range.key === "marginX" ? Math.max(range.max, marginPercent() ?? 0) : range.max} step={range.step} value={rangeValue(range.key) ?? range.fallback} disabled={immutable()} onInput={event => { const value = Number(event.currentTarget.value); if (range.key === "marginX") editMargin(value); else edit(range.key, value); }} />
        <span class="kt-range-value"><output for={`kt-${range.key}`} class={draft().settings[range.key] === null ? "is-inherited" : undefined} title={range.key === "marginX" && draft().settings.marginX !== null && draft().settings.marginXUnit === "em" ? "旧方案单位，随 Kindle 字号缩放；拖动后改用 %" : undefined}>{range.key === "marginX" ? marginText() : draft().settings[range.key] === null ? "书籍" : `${draft().settings[range.key]}${range.unit}`}</output>
        <button class="quiet kt-range-reset" type="button" aria-label={range.key === "marginX" ? "恢复 Kindle 默认" : "恢复沿用书籍"} title={range.key === "marginX" ? "恢复 Kindle 默认" : "恢复沿用书籍"} hidden={draft().settings[range.key] === null} disabled={immutable() || draft().settings[range.key] === null} onClick={() => { if (range.key === "marginX") editMargin(null); else edit(range.key, null); }}>↺</button></span>
      </div>}</For>
      <Select label="字体（设备上已安装）" value={draft().settings.fontFamily ?? ""} disabled={immutable()} onChange={event => edit("fontFamily", event.currentTarget.value || null)}>
        <option value="">设备默认字体</option>
        <Show when={draft().settings.fontFamily && !fonts().some(font => font.name === draft().settings.fontFamily)}><option value={draft().settings.fontFamily!}>{draft().settings.fontFamily}（尚未在当前设备读取到）</option></Show>
        <For each={fonts()}>{family => <option value={family.name}>{family.name}</option>}</For>
      </Select>
      <Show when={draft().settings.fontFamily && !fonts().some(font => font.name === draft().settings.fontFamily)}><p class="muted">所选字体当前不可用，预览暂用替代字体；传书前请确认设备已安装此字体。</p></Show>
      <div class="kt-checkboxes" role="group" aria-label="正文样式">
        <Checkbox label="两端对齐" checked={draft().settings.justify === true} disabled={immutable()} onChange={event => edit("justify", event.currentTarget.checked)} />
        <Checkbox label="去掉书籍自带字体" checked={draft().settings.stripFonts} disabled={immutable()} onChange={event => edit("stripFonts", event.currentTarget.checked)} />
        <Checkbox label="去掉所有图片" checked={draft().settings.stripImages} disabled={immutable()} onChange={event => edit("stripImages", event.currentTarget.checked)} />
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
          <Button variant="quiet" disabled={!target() || immutable() || draft().id === "draft"} onClick={() => setDeleting(true)}>删除</Button>
          <Button variant="secondary" disabled={!canStore()} onClick={openSaveAs}>另存为</Button>
          <Button disabled={!canStore() || !dirty()} onClick={() => save()}>保存方案</Button></div>
      </Show>
    </section><section class="kt-preview kt-preview-sticky" aria-label="设备预览">
      <div class="kt-preview-header">
      <div class="kt-preview-toolbar"><div class="kt-preview-selectors"><PreviewBookPicker books={props.data.books} value={bookId()} disabled={!props.data.books.length} onChange={id => { void chooseBook(id); }} />
        <Select label="章节" value={String(chapter())} disabled={chapterLoading() || !sections().length} onChange={event => openChapter(Number(event.currentTarget.value))}><For each={sections()}>{(section, index) => <option value={String(index())}>{section.title}</option>}</For></Select>
        <Select label="Kindle 页边距设置" value={draft().settings.kindleMargin} disabled={busy() || loading()} onChange={event => {
          const kindleMargin = event.currentTarget.value as KindleMarginPreset;
          setDraft(old => ({ ...old, settings: { ...old.settings, kindleMargin } }));
        }}><For each={Object.entries(KINDLE_MARGIN_PRESETS)}>{([value, label]) => <option value={value}>{label}</option>}</For></Select>
      </div></div>
      <Show when={chapterLoading()}><p role="status">正在读取章节…</p></Show><Show when={chapterError()}><p role="alert" class="field-error">{chapterError()}</p></Show>
      <Show when={bookId() && chapterError()}><Button variant="secondary" disabled={chapterLoading()} onClick={() => chooseBook(bookId())}>重新读取章节</Button></Show>
      <Show when={!props.data.books.length}><p class="notice">书库中还没有可预览的 EPUB。</p></Show><Show when={bookId() && !sections().length && !chapterLoading() && !chapterError()}><p class="notice">这本书没有可预览的章节。</p></Show>
      </div>
      <ChapterFrame src={sections()[chapter()] ? previewContentUrl(bookId(), sections()[chapter()].item_path, draft().settings) : ""} model={effectiveModel()} marginPreset={draft().settings.kindleMargin} css={css()} device={fontDevice()} family={fonts().find(font => font.name === draft().settings.fontFamily)} start={chapterStart()} hasPrevious={chapter() > 0} hasNext={chapter() + 1 < sections().length} onChapter={direction => openChapter(chapter() + direction, direction < 0 ? Number.MAX_SAFE_INTEGER : 1)} />
      <p class="muted" data-kindle-line-estimate>{settingsError() ? "排版参数无效，预览保留上次有效样式。" : `预计每行约 ${metrics().charsPerLine} 字（${metrics().measured ? "按 KPW3" : effectiveModel() === "other" ? "其他型号按 KPW3 比例估算" : "KO3 按 KPW3 比例估算"} · 字号 7 · ${KINDLE_MARGIN_PRESETS[draft().settings.kindleMargin]}${metrics().measured ? " 实测校准" : ""}）`}</p>
      <details class="kt-calibration"><summary>校准说明</summary>
        <p class="kt-spec">{effectiveModel() === "other" ? "其他（按 KPW3 预览）" : `${effectiveModel()} · ${KINDLE_MODELS[effectiveModel()].inches} 英寸`} · {screenFor(effectiveModel()).width}×{screenFor(effectiveModel()).height} · 按比例缩放</p>
        <p class="muted">请选择与 Kindle 一致的页边距档位；随方案保存，仅用于预览和边界校验，不写入书籍 CSS。</p>
        <p class="muted">按霞鹜文楷 轻便版 Medium 的全宽汉字估计，书籍字号、缩进及自定义 CSS 会影响字数。行距按 Kindle「最宽」行距实测（书籍或方案指定的行高优先）；上下页边距按 KPW3 窄边距实测，其他档位与型号为估算。不模拟 Kindle 页眉页脚文字。Kindle 自身字号仍生效，浏览器与 Kindle 排版引擎也有差异。</p>
      </details>
    </section></div>
    <Dialog open={saveAs()} title={draft().builtIn ? "新建排版方案" : "另存为排版方案"} onClose={() => { if (!busy()) setSaveAs(false); }}><form onSubmit={event => { event.preventDefault(); void save(true); }}>
      <TextField label="新方案名称" value={saveName()} maxlength={100} required disabled={busy()} onInput={event => setSaveName(event.currentTarget.value)} /><p class="muted">保存到 {target()?.name}。默认方案始终保留。</p>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show><div class="kt-actions"><Button variant="secondary" disabled={busy()} onClick={() => setSaveAs(false)}>取消</Button><Button type="submit" disabled={!canStore() || !saveName().trim()}>保存新方案</Button></div>
    </form></Dialog>
    <ConfirmDialog open={deleting()} title="删除排版方案？" danger onClose={() => { if (!busy()) setDeleting(false); }} onConfirm={remove}><p>删除「{draft().name}」{dirty() ? "及其未保存的修改" : ""}？已经发送到设备的书籍不会改变。</p></ConfirmDialog>
  </section>;
}
