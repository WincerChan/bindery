import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { defaultProfile, EMPTY_SETTINGS, generateProfileCss, profileSettings, type ProfileSettings, type TypesettingProfile } from "../../../client/kindle/profiles";
import { deviceInventory } from "../../../client/kindle/inventory";
import { errorMessage } from "../../../client/kindle/fs";
import { KINDLE_MODELS, type KindleModel } from "../../../client/kindle/identity";
import type { FontFamily, KindleDeviceManager } from "../../../client/kindle";
import { validateCss } from "../../../core/css";
import { contentUrl } from "../../reader/model";
import { Button, Checkbox, ConfirmDialog, Dialog, Select, Textarea, TextField } from "../../../ui";
import { usePageDevice } from "./device";
import { ChapterFrame } from "./frames";
import { screenFor, type PreviewChapter, type PreviewData } from "./model";

export interface ProfileApi {
  list(deviceId: string): Promise<TypesettingProfile[]>;
  create(profile: { deviceId: string; name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  update(profile: { deviceId: string; id: string; name: string; settings: ProfileSettings }): Promise<TypesettingProfile>;
  delete(deviceId: string, id: string): Promise<unknown>;
}
const ranges = [
  { key: "marginX", label: "左右边距", unit: "em", min: 0, fallback: 1, step: 0.1 },
  { key: "marginY", label: "上下边距", unit: "em", min: 0, fallback: 1, step: 0.1 },
  { key: "lineHeight", label: "行高", unit: "", min: 0.5, fallback: 1.6, step: 0.05 },
  { key: "paragraphSpacing", label: "段间距", unit: "em", min: 0, fallback: 0, step: 0.1 },
  { key: "textIndent", label: "首行缩进", unit: "em", min: 0, fallback: 2, step: 0.1 },
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
  const [chapterLoading, setChapterLoading] = createSignal(false), [chapterError, setChapterError] = createSignal(props.data.error);
  let disposed = false, profileRequest = 0, fontRequest = 0, chapterRequest = 0, initialFontApplied = false;
  const dirty = () => JSON.stringify(draft()) !== baseline();
  const cssError = () => validateCss(draft().settings.customCss);
  const settingsError = () => { try { profileSettings(draft().settings); return ""; } catch (error) { return errorMessage(error); } };
  const css = () => settingsError() ? null : generateProfileCss(draft());
  const connected = () => state()?.status === "granted" ? state()!.device : null;
  const fontDevice = () => connected()?.identity.id === target()?.id ? connected() : null;
  const effectiveModel = () => target()?.model ?? model();
  const immutable = () => draft().builtIn || busy() || loading();
  const canStore = () => Boolean(target()) && !busy() && !loading() && !settingsError();
  const confirmDiscard = () => !dirty() || window.confirm("当前排版有未保存的修改，确定放弃吗？");
  createEffect(() => props.data, data => {
    chapterRequest++; setBookId(data.bookId); setSections(data.sections); setChapter(0); setChapterLoading(false); setChapterError(data.error);
  });
  function selectProfile(profile: TypesettingProfile) { setDraft(copy(profile)); setBaseline(JSON.stringify(profile)); setError(""); setNotice(""); }
  function edit<K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) {
    if (immutable()) return;
    setDraft(old => ({ ...old, settings: { ...old.settings, [key]: value } }));
  }
  createEffect(dirty, value => props.onDirty?.(value));
  onCleanup(() => { disposed = true; profileRequest++; fontRequest++; chapterRequest++; });
  // An external device switch must not silently discard a draft or retarget its save operation.
  createEffect(() => state()?.device?.identity.id, () => {
    const identity = state()?.device?.identity;
    if (identity && !dirty() && !busy()) setTarget({ id: identity.id, model: identity.model, name: identity.name });
  });
  createEffect(() => target()?.id ?? "", id => { void loadProfiles(id); });
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
  createEffect(() => `${state()?.status}:${state()?.device?.identity.id ?? ""}:${target()?.id ?? ""}`, () => { void scanFonts(); });
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
    setTarget(identity ? { id: identity.id, model: identity.model, name: identity.name } : null);
  }
  function reset() { if (confirmDiscard()) selectProfile(JSON.parse(baseline()) as TypesettingProfile); }
  function openSaveAs() { setSaveName(draft().builtIn ? "我的排版" : draft().name); setSaveAs(true); }
  async function save(asNew = false) {
    const selected = target(); if (!selected || !canStore()) return;
    if (!asNew && (draft().builtIn || draft().id === "draft")) { openSaveAs(); return; }
    setBusy(true); setError("");
    try {
      const current = draft(), settings = profileSettings(current.settings);
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
    const request = ++chapterRequest; setBookId(id); setSections([]); setChapter(0); setChapterLoading(true); setChapterError("");
    try { const result = await props.chapters(id); if (!disposed && request === chapterRequest) setSections(result); }
    catch (error) { if (!disposed && request === chapterRequest) setChapterError(errorMessage(error)); }
    finally { if (!disposed && request === chapterRequest) setChapterLoading(false); }
  }
  const availableTargets = () => {
    const items = remembered().map(device => device.identity);
    const identity = state()?.device?.identity;
    if (identity && !items.some(item => item.id === identity.id)) items.unshift(identity);
    const selected = target(); if (selected && !items.some(item => item.id === selected.id)) items.push({ ...selected, created_at: "" });
    return items;
  };
  return <section class="kt-page" aria-label="排版与预览">
    <div class="kt-heading"><div><h2>排版与预览</h2><p class="muted">为每台 Kindle 保存排版方案，转换时应用到发送的书籍。</p></div>
      <Select label="方案所属设备" value={target()?.id ?? ""} disabled={busy()} onChange={event => { chooseTarget(event.currentTarget.value); event.currentTarget.value = target()?.id ?? ""; }}>
        <option value="">仅预览型号</option><For each={availableTargets()}>{device => <option value={device.id}>{device.name} · {device.model}</option>}</For>
      </Select></div>
    <Show when={!state()}><p role="status">检测中…</p></Show>
    <Show when={!fontDevice()}><p class="notice">排版方案属于已配对的设备。可选择记住的设备离线编辑；连接并授权后才能加载设备字体。<a href="/kindle/connect">连接设备</a></p></Show>
    <Show when={!target()}><Select label="预览型号" value={model()} onChange={event => setModel(event.currentTarget.value as KindleModel)}><option value="KPW3">Kindle Paperwhite 3 · 6 英寸</option><option value="KO3">Kindle Oasis 3 · 7 英寸</option><option value="other">其他（按 KPW3 预览）</option></Select></Show>
    <Show when={connected() && target() && connected()!.identity.id !== target()!.id}><p class="notice">当前连接的设备与正在编辑的方案所属设备不同；保存仍属于 {target()!.name}。</p></Show>
    <Show when={error() || memoryError()}><p role="alert" class="field-error">{error() || memoryError()}</p></Show>
    <Show when={settingsError() && !cssError()}><p role="alert" class="field-error">{settingsError()}</p></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <div class="kt-preview-layout"><section class="kt-editor" aria-label="排版方案编辑器">
      <h3>排版方案</h3><ul class="kt-profile-list"><For each={profiles()}>{profile => <li><button type="button" class={profile.id === draft().id ? "is-selected" : ""} aria-pressed={profile.id === draft().id ? "true" : "false"} disabled={busy() || loading()} onClick={() => { if (confirmDiscard()) selectProfile(profile); }}>{profile.builtIn ? "默认" : profile.name}{profile.builtIn ? " · 书籍自带样式" : ""}</button></li>}</For></ul>
      <Show when={loading()}><p role="status">正在读取方案…</p></Show>
      <Show when={dirty()}><p role="status">有未保存的修改</p></Show>
      <Show when={draft().builtIn}><p class="muted">默认方案不可编辑或删除。点击「另存为」建立自己的方案。</p></Show>
      <TextField label="方案名称" value={draft().name} disabled={immutable()} maxlength={100} onInput={event => setDraft(old => ({ ...old, name: event.currentTarget.value }))} />
      <For each={ranges}>{range => <div class="kt-range"><label for={`kt-${range.key}`}><span>{range.label}</span><output>{draft().settings[range.key] === null ? "沿用书籍" : `${draft().settings[range.key]} ${range.unit}`}</output></label>
        <input id={`kt-${range.key}`} aria-label={`${range.label}${range.unit ? `（${range.unit}）` : ""}`} type="range" min={range.min} max={20} step={range.step} value={draft().settings[range.key] ?? range.fallback} disabled={immutable()} onInput={event => edit(range.key, Number(event.currentTarget.value))} />
        <button class="quiet" type="button" disabled={immutable() || draft().settings[range.key] === null} onClick={() => edit(range.key, null)}>沿用书籍</button></div>}</For>
      <Select label="字体（设备上已安装）" value={draft().settings.fontFamily ?? ""} disabled={immutable()} onChange={event => edit("fontFamily", event.currentTarget.value || null)}>
        <option value="">设备默认字体（保留书籍字体样式）</option>
        <Show when={draft().settings.fontFamily && !fonts().some(font => font.name === draft().settings.fontFamily)}><option value={draft().settings.fontFamily!}>{draft().settings.fontFamily}（尚未在当前设备读取到）</option></Show>
        <For each={fonts()}>{family => <option value={family.name}>{family.name}</option>}</For>
      </Select>
      <Show when={draft().settings.fontFamily && !fonts().some(font => font.name === draft().settings.fontFamily)}><p class="muted">所选字体当前不可用，预览暂用替代字体；传书前请确认设备已安装此字体。</p></Show>
      <Checkbox label="两端对齐" checked={draft().settings.justify === true} disabled={immutable()} onChange={event => edit("justify", event.currentTarget.checked)} />
      <Button variant="quiet" disabled={immutable() || draft().settings.justify === null} onClick={() => edit("justify", null)}>{draft().settings.justify === null ? "对齐方式沿用书籍" : "对齐方式恢复书籍设置"}</Button>
      <Textarea label="额外自定义 CSS" rows={6} value={draft().settings.customCss} disabled={immutable()} error={cssError() ?? undefined} onInput={event => edit("customCss", event.currentTarget.value)} />
      <Textarea label="生成的 CSS（只读）" rows={8} class="kt-generated" readonly value={css() ?? "排版参数校验未通过，预览保留上次有效样式。"} />
      <div class="kt-actions"><Button variant="quiet" disabled={busy() || loading() || !dirty()} onClick={reset}>重置</Button><Button variant="quiet" disabled={!target() || immutable() || draft().id === "draft"} onClick={() => setDeleting(true)}>删除</Button><Button variant="secondary" disabled={!canStore()} onClick={openSaveAs}>另存为</Button><Button disabled={!canStore() || draft().builtIn || !dirty()} onClick={() => save()}>保存</Button></div>
    </section><section class="kt-preview" aria-label="设备预览">
      <div class="kt-preview-selectors"><Select label="预览书籍" value={bookId()} disabled={!props.data.books.length} onChange={event => { void chooseBook(event.currentTarget.value); }}><For each={props.data.books}>{book => <option value={book.id}>{book.title}{book.author ? ` · ${book.author}` : ""}</option>}</For></Select>
        <Select label="章节" value={String(chapter())} disabled={chapterLoading() || !sections().length} onChange={event => setChapter(Number(event.currentTarget.value))}><For each={sections()}>{(section, index) => <option value={String(index())}>{section.title}</option>}</For></Select></div>
      <p class="kt-spec">{KINDLE_MODELS[effectiveModel()].name} · {screenFor(effectiveModel()).width}×{screenFor(effectiveModel()).height} · 300 ppi · 按比例缩放</p>
      <Show when={chapterLoading()}><p role="status">正在读取章节…</p></Show><Show when={chapterError()}><p role="alert" class="field-error">{chapterError()}</p></Show>
      <Show when={bookId() && chapterError()}><Button variant="secondary" disabled={chapterLoading()} onClick={() => chooseBook(bookId())}>重新读取章节</Button></Show>
      <Show when={!props.data.books.length}><p class="notice">书库中还没有可预览的 EPUB。</p></Show><Show when={bookId() && !sections().length && !chapterLoading() && !chapterError()}><p class="notice">这本书没有可预览的章节。</p></Show>
      <ChapterFrame src={sections()[chapter()] ? contentUrl(bookId(), sections()[chapter()].item_path) : ""} model={effectiveModel()} css={css()} device={fontDevice()} family={fonts().find(font => font.name === draft().settings.fontFamily)} />
      <p class="muted">预览保留书籍本身的样式。实际效果还会叠加 Kindle 自身的字号与页边距设置；浏览器与 Kindle 的排版引擎也有差异。</p>
    </section></div>
    <Dialog open={saveAs()} title="另存为排版方案" onClose={() => { if (!busy()) setSaveAs(false); }}><form onSubmit={event => { event.preventDefault(); void save(true); }}>
      <TextField label="新方案名称" value={saveName()} maxlength={100} required disabled={busy()} onInput={event => setSaveName(event.currentTarget.value)} /><p class="muted">保存到 {target()?.name}。默认方案始终保留。</p>
      <Show when={error()}><p role="alert" class="field-error">{error()}</p></Show><div class="kt-actions"><Button variant="secondary" disabled={busy()} onClick={() => setSaveAs(false)}>取消</Button><Button type="submit" disabled={!canStore() || !saveName().trim()}>保存新方案</Button></div>
    </form></Dialog>
    <ConfirmDialog open={deleting()} title="删除排版方案？" danger onClose={() => { if (!busy()) setDeleting(false); }} onConfirm={remove}><p>删除「{draft().name}」{dirty() ? "及其未保存的修改" : ""}？已经发送到设备的书籍不会改变。</p></ConfirmDialog>
  </section>;
}
